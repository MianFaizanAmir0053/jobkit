import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { Storage } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { getActiveProfile, getProfileVersion, listVersions, profileCounts } from "./profile";
import { activateByHash, seedProfile } from "./seed";
import { type ProfileFiles, validateProfile } from "./validate";

const SAMPLE_DIR = join(process.cwd(), "evals", "synthetic");
const SAMPLE = readFileSync(join(SAMPLE_DIR, "profile.sample.yaml"), "utf8");
const DAY = 24 * 60 * 60 * 1000;

let db: PgliteDb;
let clock: FakeClock;
let dir: string;
let storage: Storage;
let puts: string[];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.profile_versions");
  clock = fakeClock();
  dir = mkdtempSync(join(tmpdir(), "jobkit-profile-"));
  const local = createLocalStorage({ root: dir, origin: "http://localhost:3000" });
  puts = [];
  storage = {
    ...local,
    // Like Supabase Storage: an object that exists is replaced only when asked.
    put: async (path, bytes, type, options) => {
      if (!options?.overwrite && (await local.stat(path)) !== null) {
        throw new Error("The resource already exists");
      }
      puts.push(path);
      await local.put(path, bytes, type, options);
    },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({ db, storage, clock });

function files(overrides: Record<string, Uint8Array> = {}): ProfileFiles {
  return {
    read: (path) => overrides[path] ?? new Uint8Array(readFileSync(join(SAMPLE_DIR, path))),
  };
}

function valid(text = SAMPLE, overrides: Record<string, Uint8Array> = {}) {
  const result = validateProfile(text, files(overrides));
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}

async function versions(): Promise<{ id: string; active: boolean }[]> {
  const { rows } = await db.query<{ id: string; active: boolean }>(
    "select id, active from {{schema}}.profile_versions order by created_at",
  );
  return rows;
}

/** Seeds a profile the test expects to be stored, and returns its version. */
async function seeded(
  input: ReturnType<typeof valid>,
): Promise<{ status: string; versionId: string }> {
  const result = await seedProfile(deps(), input);
  if (result.status === "refused") throw new Error(result.message);
  return result;
}

describe("seedProfile", () => {
  it("stores a new version and makes it active", async () => {
    const result = await seeded(valid());

    expect(result).toEqual({ status: "created", versionId: expect.any(String) });
    expect(await versions()).toEqual([{ id: result.versionId, active: true }]);
  });

  it("creates nothing for an unchanged profile, and makes an older file's version active again", async () => {
    const first = await seeded(valid());
    clock.advance(DAY);
    const edited = valid(
      SAMPLE.replace('notice_period: "One month"', 'notice_period: "Two weeks"'),
    );
    const second = await seeded(edited);

    expect(await seedProfile(deps(), edited)).toEqual({
      status: "unchanged",
      versionId: second.versionId,
    });
    expect(await seedProfile(deps(), valid())).toEqual({
      status: "reactivated",
      versionId: first.versionId,
    });
    expect(await versions()).toEqual([
      { id: first.versionId, active: true },
      { id: second.versionId, active: false },
    ]);
  });

  it("uploads the CV once per content, and returns its label with the profile", async () => {
    await seedProfile(deps(), valid());
    clock.advance(DAY);
    await seedProfile(deps(), valid(SAMPLE.replace('label: "sample"', 'label: "sample-2"')));

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(/^profile\/cv-[0-9a-f]{64}\.pdf$/);
    expect(await storage.stat(puts[0]!)).not.toBeNull();
    expect((await getActiveProfile(db))?.cv).toEqual({ path: puts[0], label: "sample-2" });

    const otherCv = new TextEncoder().encode("%PDF-1.4 another CV");
    await seedProfile(
      deps(),
      valid(SAMPLE.replace('label: "sample"', 'label: "sample-3"'), { "cv.sample.pdf": otherCv }),
    );
    expect(puts).toHaveLength(2);
  });

  it("refuses a CV label that already names another CV, since applications log the label", async () => {
    await seedProfile(deps(), valid());
    const otherCv = new TextEncoder().encode("%PDF-1.4 another CV");

    expect(await seedProfile(deps(), valid(SAMPLE, { "cv.sample.pdf": otherCv }))).toEqual({
      status: "refused",
      message:
        "cv.label already names a different CV in an earlier version; give this CV a new label",
    });
    expect(await versions()).toHaveLength(1);
  });

  it("uploads the CV again when the stored copy is cut short", async () => {
    const checked = valid();
    const path = `profile/cv-${createHash("sha256").update(checked.cv).digest("hex")}.pdf`;
    await storage.put(path, checked.cv.subarray(0, 10), "application/pdf");
    puts = [];

    await seedProfile(deps(), checked);

    expect(puts).toEqual([path]);
    expect(await storage.stat(path)).toEqual({ size: checked.cv.length });
  });

  it("stores one version when two seeds of the same files run at once", async () => {
    const results = await Promise.all([seedProfile(deps(), valid()), seedProfile(deps(), valid())]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "unchanged"]);
    expect(await versions()).toHaveLength(1);
  });

  it("gives a CV label to one CV only, when two seeds of different CVs run at once", async () => {
    const otherCv = new TextEncoder().encode("%PDF-1.4 another CV");

    const results = await Promise.all([
      seedProfile(deps(), valid()),
      seedProfile(
        deps(),
        valid(SAMPLE.replace('notice_period: "One month"', 'notice_period: "Two weeks"'), {
          "cv.sample.pdf": otherCv,
        }),
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "refused"]);
    expect(await versions()).toHaveLength(1);
  });
});

describe("getActiveProfile", () => {
  it("returns approved facts and known gaps only, never one waiting for approval", async () => {
    const text = SAMPLE.replace(
      "      approved: true\nfixed_answers:",
      '      approved: true\n    - id: K-waiting\n      skills: [go]\n      line: "Not approved yet."\n      approved: false\nfixed_answers:',
    );
    await seedProfile(deps(), valid(text));

    const profile = await getActiveProfile(db);

    expect(profile?.facts.map((fact) => fact.id)).toEqual([
      "F-react-production",
      "F-node-apis",
      "F-python-side",
      "F-docker-deploys",
      "F-rag-feature",
    ]);
    expect(profile?.knownGaps.map((gap) => gap.id)).toEqual(["K-kubernetes"]);
    expect(JSON.stringify(profile)).not.toMatch(/F-unapproved-example|K-waiting|Not approved yet/);
    expect(profile).toMatchObject({
      owner: { name: "Sam Rivera" },
      signature: expect.stringContaining("Sam Rivera"),
      gapTemplates: [{ id: "G-not-professional" }],
      fixedAnswers: { notice_period: "One month" },
      styleExamples: [
        expect.stringContaining("Frontend Developer"),
        expect.any(String),
        expect.any(String),
      ],
    });
  });

  it("is null before any profile is seeded", async () => {
    expect(await getActiveProfile(db)).toBeNull();
  });
});

describe("getProfileVersion", () => {
  it("keeps an older version retrievable by ID after a new one is seeded", async () => {
    const first = await seeded(valid());
    clock.advance(DAY);
    await seedProfile(
      deps(),
      valid(SAMPLE.replace('notice_period: "One month"', 'notice_period: "Two weeks"')),
    );

    expect(await getProfileVersion(db, first.versionId)).toMatchObject({
      versionId: first.versionId,
      fixedAnswers: { notice_period: "One month" },
    });
    expect((await getActiveProfile(db))?.fixedAnswers.notice_period).toBe("Two weeks");
    expect(await getProfileVersion(db, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  it("is null for an ID that is not a UUID, rather than a database error", async () => {
    expect(await getProfileVersion(db, "not-a-version")).toBeNull();
    expect(await profileCounts(db, "not-a-version")).toBeNull();
  });
});

describe("profileCounts", () => {
  it("counts a version's approved and waiting items without handing out the waiting ones", async () => {
    const { versionId } = await seeded(valid());

    expect(await profileCounts(db, versionId)).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      facts: { approved: 5, waiting: 1 },
      knownGaps: { approved: 1, waiting: 0 },
    });
  });

  it("counts the version it is given, not whichever one is active by then", async () => {
    const first = await seeded(valid());
    clock.advance(DAY);
    await seedProfile(deps(), valid(SAMPLE.replace("approved: false", "approved: true")));

    expect((await profileCounts(db, first.versionId))?.facts).toEqual({ approved: 5, waiting: 1 });
    expect(await profileCounts(db, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });
});

describe("listVersions and activateByHash", () => {
  it("lists every stored version, newest first, with its hash and counts", async () => {
    const first = await seeded(valid());
    clock.advance(DAY);
    const second = await seeded(valid(SAMPLE.replace("approved: false", "approved: true")));

    expect(await listVersions(db)).toEqual([
      {
        versionId: second.versionId,
        createdAt: clock.now(),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        active: true,
        facts: { approved: 6, waiting: 0 },
      },
      {
        versionId: first.versionId,
        createdAt: new Date(clock.now().getTime() - DAY),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        active: false,
        facts: { approved: 5, waiting: 1 },
      },
    ]);
  });

  it("makes a stored version active again by the start of its hash, which is how the owner rolls back", async () => {
    const first = await seeded(valid());
    clock.advance(DAY);
    await seeded(valid(SAMPLE.replace("approved: false", "approved: true")));
    const older = (await listVersions(db))[1]!;

    expect(await activateByHash(db, older.hash.slice(0, 8))).toEqual({
      status: "reactivated",
      versionId: first.versionId,
    });
    expect(await activateByHash(db, older.hash.slice(0, 8).toUpperCase())).toEqual({
      status: "unchanged",
      versionId: first.versionId,
    });
    expect((await getActiveProfile(db))?.versionId).toBe(first.versionId);
  });

  it("refuses a hash start that is too short, matches no version, or matches more than one", async () => {
    const stored = valid();
    for (const hash of ["abcdef01".padEnd(64, "0"), "abcdef02".padEnd(64, "0")]) {
      await db.query(
        `insert into {{schema}}.profile_versions
           (hash, document, style_examples, cv_path, cv_label, created_at)
         values ($1, $2::jsonb, $3, 'profile/cv-x.pdf', 'sample', $4)`,
        [hash, JSON.stringify(stored.profile), stored.styleExamples, clock.now()],
      );
    }

    expect(await activateByHash(db, "abc")).toEqual({
      status: "refused",
      message: "give at least the first 6 characters of a version's hash, as --list shows them",
    });
    expect(await activateByHash(db, "fedcba")).toEqual({
      status: "refused",
      message: "no stored version's hash starts with fedcba",
    });
    expect(await activateByHash(db, "abcdef")).toEqual({
      status: "refused",
      message: "more than one stored version's hash starts with abcdef; give more of it",
    });
  });
});
