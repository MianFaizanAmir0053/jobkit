import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { Storage } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { getActiveProfile, getProfileVersion, profileCounts } from "./profile";
import { seedProfile } from "./seed";
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
    put: async (path, bytes, type) => {
      puts.push(path);
      await local.put(path, bytes, type);
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

describe("seedProfile", () => {
  it("stores a new version and makes it active", async () => {
    const result = await seedProfile(deps(), valid());

    expect(result).toEqual({ status: "created", versionId: expect.any(String) });
    expect(await versions()).toEqual([{ id: result.versionId, active: true }]);
  });

  it("creates nothing for an unchanged profile, and makes an older file's version active again", async () => {
    const first = await seedProfile(deps(), valid());
    clock.advance(DAY);
    const edited = valid(
      SAMPLE.replace('notice_period: "One month"', 'notice_period: "Two weeks"'),
    );
    const second = await seedProfile(deps(), edited);

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
    await seedProfile(deps(), valid(SAMPLE, { "cv.sample.pdf": otherCv }));
    expect(puts).toHaveLength(2);
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
    const first = await seedProfile(deps(), valid());
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
});

describe("profileCounts", () => {
  it("counts a version's approved and waiting items without handing out the waiting ones", async () => {
    const { versionId } = await seedProfile(deps(), valid());

    expect(await profileCounts(db, versionId)).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      facts: { approved: 5, waiting: 1 },
      knownGaps: { approved: 1, waiting: 0 },
    });
  });

  it("counts the version it is given, not whichever one is active by then", async () => {
    const first = await seedProfile(deps(), valid());
    clock.advance(DAY);
    await seedProfile(deps(), valid(SAMPLE.replace("approved: false", "approved: true")));

    expect((await profileCounts(db, first.versionId))?.facts).toEqual({ approved: 5, waiting: 1 });
    expect(await profileCounts(db, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });
});
