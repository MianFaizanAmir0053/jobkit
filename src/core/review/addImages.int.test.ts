import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { answer, fakeLlm } from "@/adapters/fakeLlm";
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
import { jobView } from "./jobView";
import { recordReview } from "./kitReview";
import { KIT_DRAFT, readyKit, resetKitBed } from "./testKit";

/*
 * "Add screenshots" (intake AC11, drafting AC11): a form's questions added
 * to a ready kit are read, answered and checked alone, the kit's own blocks,
 * answers, verdicts and the owner's decisions untouched; more of the post
 * sends the job back to read it whole.
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
  it("reads a form's new questions and answers and checks them alone, keeping the kit and the owner's decisions", async () => {
    const id = await readyKit({ db, clock, storage }, "Northwind is hiring.", {
      record: throughAForm,
      draft: FORM,
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "Q1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "Q2", verdict: "supported", companyClaim: false, note: "" },
      ],
    });
    await recordReview({ db, clock, dns: offlineDns() }, id, {
      kind: "choose",
      questionId: "Q1",
      use: "drafted",
      was: "",
    });
    const before = (await jobView({ db, clock }, id))!;

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
    expect(after.review!.decisions.choices).toEqual({ Q1: "drafted" });
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
    expect(after.kitParts!.verdicts.find((verdict) => verdict.blockId === "Q3")).toMatchObject({
      verdict: "supported",
    });
    // The separate check weighed the new drafted answer alone.
    const judged = JSON.stringify(llm.calls[2]!.content);
    expect(judged).toContain("payment products");
    expect(judged).not.toContain("Carder");
  });

  it("sends a ready job back to read its post again whole when more of the post is added", async () => {
    const id = await readyKit({ db, clock, storage }, "Northwind is hiring.", {
      record: throughAForm,
      draft: FORM,
    });

    expect(await add(id, "post", [await screenshot(80)])).toEqual({ ok: true });
    expect(await loadJob(db, id)).toMatchObject({ state: "extracting", pendingStage: "extract" });
  });
});
