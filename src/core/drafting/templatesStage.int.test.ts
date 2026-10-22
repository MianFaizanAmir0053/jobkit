import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { KitOf } from "@/core/extraction/owner";
import { loadJob } from "@/core/platform/jobs";
import { type StageContext, stageOutput } from "@/core/platform/runner";
import { getActiveProfile } from "@/core/profile/profile";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { kitOfJob } from "@/core/review/kitType";
import { readyKit, resetKitBed, SYNTHETIC } from "@/core/review/testKit";
import { createTestDb } from "@/server/db/testDb";

import { templatesStage } from "./templatesStage";

/*
 * What the `templates` stage's input hash covers (platform spec B9, "Stage
 * runs and idempotency"; AC17): a kept output is reused only for the same
 * reading of the post, role, profile version and build.
 */

const POST = "Northwind Analytics is hiring. Apply by email to jobs@example.com.";

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

async function contextOf(id: string): Promise<StageContext> {
  return { job: (await loadJob(db, id))!, outputOf: (stage) => stageOutput(db, id, stage) };
}

/** The sample profile with one change, seeded as a new active version. */
async function seedEdited(edit: (yaml: string) => string): Promise<string> {
  const checked = validateProfile(
    edit(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8")),
    { read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))) },
  );
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  const seeded = await seedProfile({ db, storage, clock }, checked);
  if (seeded.status === "refused") throw new Error(seeded.message);
  return seeded.versionId;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-templates-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("templates' input", () => {
  it("covers the reading of the post, the chosen role, the profile version and the build's version", async () => {
    const id = await readyKit({ db, clock, storage }, POST);
    const ctx = await contextOf(id);
    const inputOf = async (kitOf: KitOf = kitOfJob) =>
      (await templatesStage({ db, kitOf }).input(ctx)) as Record<string, unknown>;

    const input = await inputOf();

    expect(input).toEqual({
      record: (await stageOutput(db, id, "extract"))!.outputHash,
      role: "P1",
      profile: (await getActiveProfile(db))!.versionId,
      build: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The templates are emails: a kit of another type is named, and gets no template draft.
    expect(await inputOf(async () => "message")).toEqual({ ...input, kit: "message" });
    // A new version of the profile drafts afresh.
    const newer = await seedEdited((yaml) => yaml.replace("+1 202 555 0143", "+1 202 555 0144"));
    expect(newer).not.toBe(input.profile);
    expect(await inputOf()).toEqual({ ...input, profile: newer });
  });
});
