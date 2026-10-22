import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { JobRecord } from "@/core/extraction/record";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { type StageContext, stageOutput } from "@/core/platform/runner";
import { readyKit, resetKitBed, SYNTHETIC } from "@/core/review/testKit";
import { createTestDb } from "@/server/db/testDb";

import type { DraftOutput } from "./draftStage";
import { JUDGE, JUDGE_PROMPT, judgeStage } from "./judgeStage";
import type { FormDraftAnswer } from "./kit";
import { NO_GAP } from "./testDrafts";

/*
 * What the `judge` stage's input hash covers (platform spec B9, "Stage runs
 * and idempotency"; AC17): the draft, or the answers added to it, and the
 * facts it cites, so a verdict is reused only for the same words weighed
 * against the same facts.
 */

const POST =
  "Fabrikam Payments is hiring a Full-Stack Developer. Apply here: https://boards.example.net/fabrikam/jobs/4471";

/** The form's cover note cites one fact; the one answer the drafter writes cites another. */
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
      text: "I want to build payment APIs in Node.js.",
      fact_ids: ["F-node-apis"],
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

/** As if the stored version's fact read otherwise, which the app never does to a version. */
async function restate(versionId: string, factId: string, statement: string): Promise<void> {
  const { rows } = await db.query<{ document: { facts: { id: string }[] } }>(
    "select document from {{schema}}.profile_versions where id = $1",
    [versionId],
  );
  const document = rows[0]!.document;
  document.facts = document.facts.map((fact) =>
    fact.id === factId ? { ...fact, statement } : fact,
  );
  await db.query("update {{schema}}.profile_versions set document = $2 where id = $1", [
    versionId,
    JSON.stringify(document),
  ]);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-judge-stage-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("judge's input", () => {
  it("covers the draft, the facts it cites, the model's settings, and the answers added to it", async () => {
    const id = await formKit();
    const ctx = await contextOf(id);
    const inputNow = async () =>
      (await judgeStage({ db, random, models: models() }).input(ctx)) as Record<string, unknown>;
    const draft = (await stageOutput(db, id, "draft"))!;

    const input = await inputNow();

    expect(input).toEqual({
      draft: draft.outputHash,
      facts: expect.stringMatching(/^[0-9a-f]{64}$/),
      model: JUDGE.model,
      effort: JUDGE.effort,
      prompt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // A form is weighed under rules of its own, so its prompt is not an email's.
    expect(input.prompt).not.toBe(JUDGE_PROMPT);

    // A fact nothing in the kit cites can change without a new check; one a drafted answer cites cannot.
    const version = (draft.output as DraftOutput).profileVersion;
    await restate(version, "F-python-side", "I have written Python scripts for data work.");
    expect(await inputNow()).toEqual(input);
    await restate(version, "F-node-apis", "I have run Node.js APIs for two years.");
    const recited = await inputNow();
    expect(recited).toEqual({ ...input, facts: recited.facts });
    expect(recited.facts).not.toBe(input.facts);

    // Answers draft_answers adds to this draft are weighed with it, by that stage's output.
    await db.query(
      `insert into {{schema}}.job_stage_runs
         (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash,
          started_at, ended_at)
       select job_id, lease_id, 'draft_answers', round, 1, 'added', 'ok', $2, 'answers-1',
              started_at, ended_at
         from {{schema}}.job_stage_runs where job_id = $1 and stage = 'draft'`,
      [id, JSON.stringify({ draft: draft.outputHash, answers: [], flags: [], markers: [] })],
    );
    expect(await inputNow()).toEqual({ ...recited, answers: "answers-1" });
  });
});
