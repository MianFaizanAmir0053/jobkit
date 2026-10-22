import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, failure, fakeLlm, type FakeLlm, type FakeStep } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { DRAFT } from "@/core/drafting/draftStage";
import { NO_GAP, S01_DRAFT, S01_JUDGED } from "@/core/drafting/testDrafts";
import { ADDRESS_READ } from "@/core/extraction/addressReadStage";
import type { JobRecord } from "@/core/extraction/record";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import type { EvalCase, RunDeps } from "./run";
import { runDrafting, runSecondRead } from "./stageRuns";

/*
 * The drafting and second-read runs (evals spec, "Metrics" and "Runs,
 * budget and reports"), on the app's own stages with fake models: a job
 * that runs out of an invocation's time is claimed again until it rests;
 * gap coverage counts only lines code wrote; a second read that gave no
 * answer is not scored.
 */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");
const BUDGET = { budgetUsd: 5 };

let db: PgliteDb;
let root: string;
let storage: LocalStorage;
let clock: FakeClock;
let llm: FakeLlm;

const deps = (): RunDeps => ({ db, storage, clock, random: cryptoRandom, llmFor: () => llm });

/** S01, AWS made a must-have the sample profile lacks, with the contact's box where a test puts it. */
function s01(box?: JobRecord["roles"][number]["route"]["box"]): JobRecord {
  const record = JSON.parse(
    readFileSync(join(SYNTHETIC, "records", "S01-email-simple.json"), "utf8"),
  ) as JobRecord;
  const role = record.roles[0]!;
  role.requirements = role.requirements.map((requirement) =>
    requirement.id === "R4" ? { ...requirement, priority: "must" } : requirement,
  );
  if (box) role.route.box = box;
  return record;
}

async function evalCase(withImage: boolean): Promise<EvalCase> {
  const png = new Uint8Array(
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .png()
      .toBuffer(),
  );
  return {
    id: "2026-03-16-8282e9a1",
    split: "dev",
    images: withImage ? [{ bytes: png, contentType: "image/png" }] : [],
    pastedText: withImage
      ? ""
      : "Northwind Analytics is hiring a Senior Full-Stack Engineer. Apply by email to jobs@example.com.",
    labels: {
      company: "Northwind Analytics",
      role: "Senior Full-Stack Engineer",
      route: "email",
      contact: "jobs@example.com",
      eligibility: "eligible",
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-stage-runs-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  await seedProfile({ db, storage, clock: fakeClock() }, checked);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runDrafting", () => {
  it("claims a job that ran out of an invocation's time again, so the draft is made and checked", async () => {
    // The post's reading takes 100 seconds: no model stage may start after it in that invocation.
    const slowRead: FakeStep = (request) => {
      clock.advance(100_000);
      return answer(s01())(request);
    };
    llm = fakeLlm([slowRead, answer(S01_DRAFT), answer(S01_JUDGED)]);

    const run = await runDrafting(deps(), [await evalCase(false)], {
      model: DRAFT.model,
      ...BUDGET,
    });

    expect(run.cases).toMatchObject([
      { outcome: "scored", answered: 1, missing: 0, verdicts: { supported: 3, not_a_claim: 2 } },
    ]);
    expect(run.gapCoverage).toMatchObject({ successes: 1, n: 1 });
  });

  it("counts a gap line code could not write as no answer to its must-have", async () => {
    // No known line or template chosen: code writes "Needs your line", the owner's to fill.
    const draft = {
      ...S01_DRAFT,
      blocks: S01_DRAFT.blocks.map((block) =>
        block.id === "S4" ? { ...block, gap: { ...NO_GAP, requirement_id: "R4" } } : block,
      ),
    };
    llm = fakeLlm([answer(s01()), answer(draft), answer(S01_JUDGED)]);

    const run = await runDrafting(deps(), [await evalCase(false)], {
      model: DRAFT.model,
      ...BUDGET,
    });

    expect(run.cases).toMatchObject([{ outcome: "scored", answered: 0, missing: 1 }]);
    expect(run.gapCoverage).toMatchObject({ successes: 0, n: 1 });
  });
});

describe("runSecondRead", () => {
  it("leaves a second read whose call gave no answer unscored", async () => {
    const box = { tile: 1, x1: 100, y1: 100, x2: 400, y2: 140 };
    llm = fakeLlm([answer(s01(box)), failure("server"), failure("server")]);

    const run = await runSecondRead(deps(), [await evalCase(true)], {
      model: ADDRESS_READ.model,
      ...BUDGET,
    });

    expect(run.cases).toMatchObject([
      { outcome: "not read", note: "The second read's call gave no answer." },
    ]);
    expect(run.falseAlarms).toMatchObject({ n: 0 });
  });
});
