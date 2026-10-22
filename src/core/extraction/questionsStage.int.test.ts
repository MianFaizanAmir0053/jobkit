import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { FormDraftAnswer } from "@/core/drafting/kit";
import { NO_GAP } from "@/core/drafting/testDrafts";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { type StageContext, stageOutput } from "@/core/platform/runner";
import { readyKit, resetKitBed, SYNTHETIC } from "@/core/review/testKit";
import { createTestDb } from "@/server/db/testDb";

import { EXTRACT } from "./extract";
import { extractQuestionsStage } from "./questionsStage";
import type { JobRecord } from "./record";

/*
 * What the `extract_questions` stage's input hash covers (platform spec B9,
 * "Stage runs and idempotency"; AC17): the form screenshots the owner added
 * to the current reading of the post, and the model's settings.
 */

const POST =
  "Fabrikam Payments is hiring a Full-Stack Developer. Apply here: https://boards.example.net/fabrikam/jobs/4471";

const FORM: FormDraftAnswer = {
  fit: [],
  blocks: [
    {
      id: "S1",
      text: "I have built production React and Next.js applications for five years.",
      paragraph_break: false,
      class: "claim",
      fact_ids: ["F-react-production"],
      fields: [],
      gap: NO_GAP,
    },
  ],
  answers: [
    { question_id: "Q1", topic: "work_authorisation", text: "", fact_ids: [] },
    { question_id: "Q2", topic: "salary", text: "", fact_ids: [] },
    { question_id: "Q3", topic: "years_with_skill", text: "", fact_ids: [] },
    {
      question_id: "Q4",
      topic: "none",
      text: "I want to build payment products with React and Node.js.",
      fact_ids: ["F-react-production", "F-node-apis"],
    },
  ],
};

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

const random = { bytes: (length: number) => new Uint8Array(length).fill(5) };

function models(): ModelCallDeps {
  return {
    db,
    clock,
    llmFor: () => {
      throw new Error("Working out the input calls no model.");
    },
    guard: async () => ({ ok: true }),
  };
}

/** S03's form, open to remote work anywhere so eligibility lets it through, run to its kit. */
async function formKit(): Promise<string> {
  const record = JSON.parse(
    readFileSync(join(SYNTHETIC, "records", "S03-ats-form.json"), "utf8"),
  ) as JobRecord;
  return readyKit({ db, clock, storage }, POST, {
    draft: FORM,
    record: () => ({
      ...record,
      roles: record.roles.map((role) => ({
        ...role,
        location: { ...role.location, places: [], remote_regions: ["worldwide"] },
      })),
    }),
  });
}

async function contextOf(id: string): Promise<StageContext> {
  return { job: (await loadJob(db, id))!, outputOf: (stage) => stageOutput(db, id, stage) };
}

/** A screenshot of the application form the owner added to the job at `at`. */
async function formImage(id: string, position: number, sha256: string, at: Date): Promise<void> {
  await db.query(
    `insert into {{schema}}.job_images
       (job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
        tile_count, created_at, purge_after)
     values ($1, $2, 'form', $3, 'image/png', 1080, 2400, 10, $4, 1, $5, $5)`,
    [id, position, `jobs/${id}/form-${position}.png`, sha256, at],
  );
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-questions-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("extract_questions' input", () => {
  it("covers the form screenshots added since the post was last read, with the reading and role they add to, and the model's settings", async () => {
    const id = await formKit();
    const ctx = await contextOf(id);
    const inputNow = async () =>
      (await extractQuestionsStage({ db, storage, random, models: models() }).input(ctx)) as Record<
        string,
        unknown
      >;
    const { rows } = await db.query<{ ended_at: Date }>(
      "select ended_at from {{schema}}.job_stage_runs where job_id = $1 and stage = 'extract'",
      [id],
    );
    const read = rows[0]!.ended_at.getTime();
    // One added before the post was read, which answered another reading's questions; two since.
    await formImage(id, 0, "b".repeat(64), new Date(read - 1_000));
    await formImage(id, 1, "c".repeat(64), new Date(read + 1_000));
    await formImage(id, 2, "d".repeat(64), new Date(read + 2_000));

    const input = await inputNow();

    expect(input).toEqual({
      extract: (await stageOutput(db, id, "extract"))!.outputHash,
      role: "P1",
      images: ["c".repeat(64), "d".repeat(64)],
      model: EXTRACT.model,
      effort: EXTRACT.effort,
      prompt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // The post read again numbers its questions afresh: the screenshots added before go with it.
    await db.query(
      `insert into {{schema}}.job_stage_runs
         (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash,
          started_at, ended_at)
       select job_id, lease_id, 'extract', round, 2, 'read again', 'ok', output, 'read again',
              $2, $2
         from {{schema}}.job_stage_runs where job_id = $1 and stage = 'extract'`,
      [id, new Date(read + 3_000)],
    );
    expect(await inputNow()).toEqual({ ...input, extract: "read again", images: [] });
  });
});
