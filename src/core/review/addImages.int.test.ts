import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { answer, fakeLlm, type FakeStep, refusal } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { draftAnswersStage } from "@/core/drafting/answersStage";
import { judgeStage } from "@/core/drafting/judgeStage";
import type { FormDraftAnswer, FormKit } from "@/core/drafting/kit";
import { extractQuestionsStage } from "@/core/extraction/questionsStage";
import type { JobRecord } from "@/core/extraction/record";
import type { ImageMeta } from "@/core/intake/limits";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { claimJob, runJob } from "@/core/platform/runner";
import { createTestDb } from "@/server/db/testDb";

import { confirmAdd, startAdd } from "./addImages";
import { backToDrafts } from "./draftChoice";
import { jobView } from "./jobView";
import { recordReview } from "./kitReview";
import { KIT_DRAFT, readyKit, resetKitBed, SYNTHETIC } from "./testKit";

/*
 * "Add screenshots" (intake AC11, drafting AC11): a form's questions added
 * to a ready kit are read, answered and checked alone, the kit's own blocks,
 * answers, verdicts and the owner's decisions untouched, each call logged
 * under its stage (extraction AC12); more of the post sends the job back to
 * read it whole, but for a post stopped for its language (extraction AC6).
 */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

const random = { bytes: (length: number) => new Uint8Array(length).fill(9) };

const throughAForm = (record: JobRecord): JobRecord => ({
  ...record,
  roles: record.roles.map((role) => ({
    ...role,
    route: { ...role.route, kind: "ats_form", address: "https://jobs.example.com/apply" },
    screening_questions: [
      { id: "Q1", text: "Have you integrated Visa payments?", addressed_to_ai: false },
      { id: "Q2", text: "Tell us about a product you shipped.", addressed_to_ai: false },
    ],
  })),
});

const FORM: FormDraftAnswer = {
  ...KIT_DRAFT,
  answers: [
    {
      question_id: "Q1",
      topic: "none",
      text: "Yes, in two React shops.",
      fact_ids: ["F-react-production"],
    },
    {
      question_id: "Q2",
      topic: "none",
      text: "I shipped Carder, a React app used in production.",
      fact_ids: ["F-react-production"],
    },
  ],
};

async function screenshot(shade: number): Promise<{ bytes: Uint8Array; meta: ImageMeta }> {
  const bytes = new Uint8Array(
    await sharp({
      create: { width: 1080, height: 1600, channels: 3, background: { r: shade, g: shade, b: 0 } },
    })
      .png()
      .toBuffer(),
  );
  return {
    bytes,
    meta: {
      contentType: "image/png",
      bytes: bytes.length,
      width: 1080,
      height: 1600,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/** Adds screenshots as the page does: upload URLs, the uploads, then the confirmation. */
async function add(
  id: string,
  purpose: "post" | "form",
  shots: { bytes: Uint8Array; meta: ImageMeta }[],
) {
  const deps = { db, clock, storage };
  const since = (await loadJob(db, id))!.stateChangedAt;
  const started = await startAdd(deps, id, { purpose, since, images: shots.map((s) => s.meta) });
  if (!started.ok) throw new Error(started.reason);
  for (const upload of started.uploads) {
    const shot = shots.find((each) => each.meta.sha256 === upload.sha256)!;
    await storage.put(upload.path, shot.bytes, "image/png");
  }
  return confirmAdd(deps, id, {
    purpose,
    since,
    images: started.uploads.map((upload) => ({
      ...shots.find((each) => each.meta.sha256 === upload.sha256)!.meta,
      path: upload.path,
    })),
  });
}

/** Runs the job's pipeline through an add's stages, the models answering with `steps` in turn. */
async function runAdd(id: string, steps: readonly FakeStep[]) {
  const llm = fakeLlm(steps);
  const models: ModelCallDeps = { db, clock, llmFor: () => llm, guard: async () => ({ ok: true }) };
  const pipeline = {
    extract_questions: extractQuestionsStage({ db, storage, random, models }),
    draft_answers: draftAnswersStage({ db, random, models }),
    judge: judgeStage({ db, random, models }),
  };
  const lease = await claimJob({ db, clock, pipeline }, id);
  await runJob({ db, clock, pipeline }, lease!);
  return llm;
}

const readyForm = () =>
  readyKit({ db, clock, storage }, "Northwind is hiring.", {
    record: throughAForm,
    draft: FORM,
    verdicts: [
      { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
      { blockId: "Q1", verdict: "supported", companyClaim: false, note: "" },
      { blockId: "Q2", verdict: "supported", companyClaim: false, note: "" },
    ],
  });

const answerIds = async (id: string) =>
  ((await jobView({ db, clock }, id))!.kit as FormKit).answers.map((each) => each.id);

const fixture = (name: string): JobRecord =>
  JSON.parse(readFileSync(join(SYNTHETIC, "records", `${name}.json`), "utf8")) as JobRecord;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-add-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("adding screenshots to a job", () => {
  it("reads a form's new questions and answers and checks them alone, keeping the kit, its verdicts and the owner's decisions", async () => {
    const id = await readyKit({ db, clock, storage }, "Northwind is hiring.", {
      record: throughAForm,
      draft: FORM,
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "Q1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "Q2", verdict: "overstated", companyClaim: false, note: "Carder is one app." },
      ],
    });
    const decide = { db, clock, dns: offlineDns() };
    await recordReview(decide, id, { kind: "choose", questionId: "Q1", use: "drafted", was: "" });
    // The owner's words for the cover note's sentence, and "I checked this" on Q2's finding.
    const words = "I have built production React applications for four years.";
    await recordReview(decide, id, { kind: "edit", blockId: "S1", text: words });
    await recordReview(decide, id, { kind: "check", blockId: "Q2" });
    const before = (await jobView({ db, clock }, id))!;
    expect(before.kitParts!.verdicts.map(({ blockId, verdict }) => [blockId, verdict])).toEqual([
      ["S1", "supported"],
      ["Q1", "supported"],
      ["Q2", "overstated"],
    ]);

    expect(await add(id, "form", [await screenshot(40)])).toEqual({ ok: true });
    expect(await loadJob(db, id)).toMatchObject({
      state: "extracting",
      pendingStage: "extract_questions",
    });

    const llm = fakeLlm([
      answer({
        questions: [
          { text: "Why do you want to join Northwind?", addressed_to_ai: false },
          { text: "What are your salary expectations in USD?", addressed_to_ai: false },
        ],
      }),
      answer({
        answers: [
          {
            question_id: "Q3",
            topic: "none",
            text: "I want to build payment products with React.",
            fact_ids: ["F-react-production"],
          },
          { question_id: "Q4", topic: "salary", text: "", fact_ids: [] },
        ],
      }),
      answer({
        verdicts: [{ block_id: "Q3", verdict: "supported", company_claim: false, note: "" }],
      }),
    ]);
    const models: ModelCallDeps = {
      db,
      clock,
      llmFor: () => llm,
      guard: async () => ({ ok: true }),
    };
    const pipeline = {
      extract_questions: extractQuestionsStage({ db, storage, random, models }),
      draft_answers: draftAnswersStage({ db, random, models }),
      judge: judgeStage({ db, random, models }),
    };
    const lease = await claimJob({ db, clock, pipeline }, id);
    await runJob({ db, clock, pipeline }, lease!);

    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
    const after = (await jobView({ db, clock }, id))!;
    // The kit and the owner's decisions stand; the new answers follow the kit's own.
    expect(after.kitKey).toBe(before.kitKey);
    expect(after.review!.decisions).toMatchObject({
      choices: { Q1: "drafted" },
      edits: { S1: words },
      checked: ["Q2"],
    });
    expect(after.kit!.blocks[0]!.text).toBe(words);
    expect(
      (after.kit as FormKit).answers.map(({ id: question, source, text }) => [
        question,
        source,
        text,
      ]),
    ).toEqual([
      ["Q1", "drafted", "Yes, in two React shops."],
      ["Q2", "drafted", "I shipped Carder, a React app used in production."],
      ["Q3", "drafted", "I want to build payment products with React."],
      ["Q4", "profile", "USD 5,000 a month"],
    ]);
    // The earlier verdicts stand as they were, the new answer's after them.
    expect(after.kitParts!.verdicts).toEqual([
      ...before.kitParts!.verdicts,
      expect.objectContaining({ blockId: "Q3", verdict: "supported" }),
    ]);
    // The separate check weighed the new drafted answer alone.
    const judged = JSON.stringify(llm.calls[2]!.content);
    expect(judged).toContain("payment products");
    expect(judged).not.toContain("Carder");
  });

  it("logs the calls that read, answer and check a form's new questions each under its own stage", async () => {
    const id = await readyForm();
    expect(await add(id, "form", [await screenshot(40)])).toEqual({ ok: true });

    await runAdd(id, [
      answer({ questions: [{ text: "Why do you want to join?", addressed_to_ai: false }] }),
      answer({
        answers: [
          {
            question_id: "Q3",
            topic: "none",
            text: "I want to build payment products with React.",
            fact_ids: ["F-react-production"],
          },
        ],
      }),
      answer({
        verdicts: [{ block_id: "Q3", verdict: "supported", company_claim: false, note: "" }],
      }),
    ]);

    // The post's reading and its draft, then the add's three calls.
    const { rows } = await db.query<{ stage: string; outcome: string }>(
      "select stage, outcome from {{schema}}.model_calls where job_id = $1 order by stage",
      [id],
    );
    expect(rows).toEqual(
      ["draft", "draft_answers", "extract", "extract_questions", "judge"].map((stage) => ({
        stage,
        outcome: "ok",
      })),
    );
  });

  it("sends a ready job back to read its post again whole when more of the post is added", async () => {
    const id = await readyKit({ db, clock, storage }, "Northwind is hiring.", {
      record: throughAForm,
      draft: FORM,
    });

    expect(await add(id, "post", [await screenshot(80)])).toEqual({ ok: true });
    expect(await loadJob(db, id)).toMatchObject({ state: "extracting", pendingStage: "extract" });
  });

  it("takes no more of a post stopped for its language, whose only way on is Skip", async () => {
    // Each runs as far as it goes: the one in Urdu stops for its language, the other with no role.
    const urdu = await readyKit({ db, clock, storage }, "ہمیں ایک ویب ڈویلپر کی ضرورت ہے", {
      record: () => fixture("S08-urdu"),
    });
    const roleless = await readyKit({ db, clock, storage }, "Northwind is hiring.", {
      record: (record) => ({ ...record, roles: [] }),
    });
    expect(await jobView({ db, clock }, urdu)).toMatchObject({
      state: "stopped",
      stopReason: "language",
    });
    expect(await jobView({ db, clock }, roleless)).toMatchObject({
      state: "stopped",
      stopReason: "no_role",
    });
    const shot = await screenshot(60);
    const deps = { db, clock, storage };
    const since = (await loadJob(db, urdu))!.stateChangedAt;

    expect(await startAdd(deps, urdu, { purpose: "post", since, images: [shot.meta] })).toEqual({
      ok: false,
      reason: "moved-on",
    });
    const path = `jobs/${urdu}/${randomUUID()}.png`;
    expect(
      await confirmAdd(deps, urdu, { purpose: "post", since, images: [{ ...shot.meta, path }] }),
    ).toEqual({ ok: false, reason: "moved-on" });
    expect(await loadJob(db, urdu)).toMatchObject({ state: "stopped" });
    // A post stopped for another reason takes more of itself, and is read again whole.
    expect(await add(roleless, "post", [shot])).toEqual({ ok: true });
    expect(await loadJob(db, roleless)).toMatchObject({
      state: "extracting",
      pendingStage: "extract",
    });
  });

  it("keeps the answers added before when a later add of the form finds no new question", async () => {
    const id = await readyForm();
    // A page of contact fields alone, then a page with a question, then the form's review page.
    expect(await add(id, "form", [await screenshot(10)])).toEqual({ ok: true });
    await runAdd(id, [answer({ questions: [] })]);
    expect(await add(id, "form", [await screenshot(20)])).toEqual({ ok: true });
    await runAdd(id, [
      answer({ questions: [{ text: "Describe a hard bug you fixed.", addressed_to_ai: false }] }),
      answer({
        answers: [
          {
            question_id: "Q3",
            topic: "none",
            text: "I traced a race in our React checkout.",
            fact_ids: ["F-react-production"],
          },
        ],
      }),
      answer({
        verdicts: [{ block_id: "Q3", verdict: "supported", company_claim: false, note: "" }],
      }),
    ]);
    expect(await add(id, "form", [await screenshot(30)])).toEqual({ ok: true });
    await runAdd(id, [answer({ questions: [] })]);

    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
    expect(await answerIds(id)).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("goes back to the kit as it was when an add fails, and refuses an add past the spend cap", async () => {
    const id = await readyForm();
    expect(await add(id, "form", [await screenshot(40)])).toEqual({ ok: true });
    await runAdd(id, [
      answer({ questions: [{ text: "Why do you want to join?", addressed_to_ai: false }] }),
      refusal(),
    ]);
    expect(await loadJob(db, id)).toMatchObject({ state: "failed", pendingStage: "draft_answers" });
    expect(await jobView({ db, clock }, id)).toMatchObject({
      canGoBackToDrafts: true,
      failedAdd: true,
    });

    expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: true });
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
    expect(await answerIds(id)).toEqual(["Q1", "Q2"]);

    // Past the cap for new jobs, nothing is read or answered.
    await db.query(
      `insert into {{schema}}.model_calls
         (stage, attempt, provider, requested_model, started_at, outcome, cost_usd)
       values ('draft', 1, 'gemini', 'gemini-3.8-flash', $1, 'ok', 30)`,
      [clock.now()],
    );
    const since = (await loadJob(db, id))!.stateChangedAt;
    const shot = await screenshot(50);
    expect(
      await startAdd({ db, clock, storage }, id, { purpose: "form", since, images: [shot.meta] }),
    ).toMatchObject({ ok: false, reason: "limits" });
  });
});
