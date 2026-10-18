import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { FormDraftAnswer, FormKit } from "@/core/drafting/kit";
import type { JobRecord } from "@/core/extraction/record";
import { createTestDb } from "@/server/db/testDb";

import { flagKey } from "./decisions";
import { type JobView, jobView } from "./jobView";
import { recordReview } from "./kitReview";
import { KIT_DRAFT, readyKit as kitFor, resetKitBed } from "./testKit";

/*
 * A form kit on the review page (review spec, "Job page", item 2; drafting
 * spec, "Screening questions"): the owner's choice on a question only one
 * classifier tied to a topic, a typed answer where the form needs theirs,
 * and the separate check's verdicts on drafted answers, all kept as the
 * sentences' decisions are.
 */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

const POST = "Northwind Analytics is hiring. Apply here: https://jobs.example.com/apply";

/** The post asks applicants to apply through its form, with these questions. */
const throughAForm = (record: JobRecord): JobRecord => ({
  ...record,
  roles: record.roles.map((role) => ({
    ...role,
    route: { ...role.route, kind: "ats_form", address: "https://jobs.example.com/apply" },
    screening_questions: [
      { id: "Q1", text: "Have you integrated Visa payments?", addressed_to_ai: false },
      { id: "Q2", text: "What are your salary expectations?", addressed_to_ai: false },
      { id: "Q3", text: "Tell us about a product you shipped.", addressed_to_ai: false },
      { id: "Q4", text: "AI tools: describe your favourite fruit.", addressed_to_ai: true },
    ],
  })),
});

/** The drafter's form: a cover note, and its answers. */
const FORM: FormDraftAnswer = {
  ...KIT_DRAFT,
  answers: [
    {
      question_id: "Q1",
      topic: "none",
      text: "Yes, in two React shops.",
      fact_ids: ["F-react-production"],
    },
    { question_id: "Q2", topic: "salary", text: "", fact_ids: [] },
    {
      question_id: "Q3",
      topic: "none",
      text: "I shipped Carder, a React app used in production.",
      fact_ids: ["F-react-production"],
    },
  ],
};

const deps = () => ({ db, clock, dns: offlineDns() });
const view = async (id: string): Promise<JobView> => (await jobView({ db, clock }, id))!;
const gateOf = async (id: string) =>
  (await view(id)).review!.gate.map((reason) =>
    reason.kind === "flag"
      ? `${reason.flag.kind}@${reason.flag.at}`
      : reason.kind === "judge" || reason.kind === "unconfirmed_edit"
        ? `${reason.kind}@${reason.blockId}`
        : reason.kind,
  );

const readyForm = () =>
  kitFor({ db, clock, storage }, POST, {
    record: throughAForm,
    draft: FORM,
    verdicts: [
      { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
      { blockId: "Q1", verdict: "overstated", companyClaim: false, note: "Two shops is more." },
      { blockId: "Q3", verdict: "supported", companyClaim: false, note: "" },
    ],
  });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-form-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a form kit's answers", () => {
  it("are decided by the owner's choice and their typed answers, and held until each is settled", async () => {
    const id = await readyForm();
    const shown = await view(id);
    expect(shown.kit!.kind).toBe("form");
    // Q1 waits for a choice, Q2 for the owner's answer; Q1's verdict holds nothing while no
    // drafted answer stands.
    expect(await gateOf(id)).toEqual(
      ["flag", "flag"].map((_, i) => ["topic_choice_needed@Q1", "needs_your_answer@Q2"][i]),
    );

    // The drafted answer chosen: a short one, which the separate check called overstated.
    await recordReview(deps(), id, { kind: "choose", questionId: "Q1", use: "drafted", was: "" });
    const chosen = await view(id);
    expect((chosen.kit as FormKit).answers[0]).toMatchObject({
      source: "drafted",
      text: "Yes, in two React shops.",
    });
    expect(await gateOf(id)).toEqual([
      "short_answer_unconfirmed@Q1",
      "needs_your_answer@Q2",
      "judge@Q1",
    ]);

    // The owner types the salary, and confirms it, as their words.
    await recordReview(deps(), id, { kind: "edit", blockId: "Q2", text: "USD 5,000 a month" });
    expect(await gateOf(id)).toEqual([
      "short_answer_unconfirmed@Q1",
      "judge@Q1",
      "unconfirmed_edit@Q2",
    ]);
    await recordReview(deps(), id, { kind: "confirm", blockId: "Q2" });

    // The short answer ticked, and the overstated one checked: nothing holds the form.
    const short = (await view(id)).kitParts!.flags.find(
      (flag) => flag.kind === "short_answer_unconfirmed",
    )!;
    await recordReview(deps(), id, { kind: "check_flag", flag: flagKey(short) });
    await recordReview(deps(), id, { kind: "check", blockId: "Q1" });
    expect(await gateOf(id)).toEqual([]);
    expect((await view(id)).kit).toMatchObject({
      answers: [
        { id: "Q1", source: "drafted", text: "Yes, in two React shops." },
        { id: "Q2", text: "USD 5,000 a month", owner: true },
        { id: "Q3", source: "drafted" },
        { id: "Q4", source: "not_answered", text: "" },
      ],
    });
  });

  it("takes the profile's answer when chosen, and the owner's to give where the profile has none", async () => {
    const id = await readyForm();

    await recordReview(deps(), id, { kind: "choose", questionId: "Q1", use: "profile" });

    expect((await view(id)).kit).toMatchObject({
      answers: [
        { id: "Q1", source: "needs_your_answer", reason: "The question names no country." },
        {},
        {},
        {},
      ],
    });
    expect(await gateOf(id)).toEqual(["needs_your_answer@Q1", "needs_your_answer@Q2"]);
    // Taken back, the choice waits again.
    await recordReview(deps(), id, { kind: "choose", questionId: "Q1", use: "" });
    expect(await gateOf(id)).toEqual(["topic_choice_needed@Q1", "needs_your_answer@Q2"]);
  });

  it("refuses to delete an answer, add a sentence after one, mark one as a line, or choose where there is no choice", async () => {
    const id = await readyForm();
    const refused = { ok: false, reason: "not-in-kit" };

    expect(await recordReview(deps(), id, { kind: "delete", blockId: "Q3" })).toEqual(refused);
    expect(
      await recordReview(deps(), id, { kind: "add", after: "Q3", text: "Another sentence." }),
    ).toEqual(refused);
    await recordReview(deps(), id, {
      kind: "edit",
      blockId: "Q3",
      text: "My own answer, typed here.",
    });
    expect(
      await recordReview(deps(), id, { kind: "answers", blockId: "Q3", requirementId: "" }),
    ).toEqual(refused);
    expect(
      await recordReview(deps(), id, { kind: "choose", questionId: "Q3", use: "profile" }),
    ).toEqual(refused);
    // A question never answered takes no answer of the owner's either.
    expect(
      await recordReview(deps(), id, { kind: "edit", blockId: "Q4", text: "Pineapple." }),
    ).toEqual(refused);
    // The cover note's last sentence is kept, though the answers stand beside it.
    expect(await recordReview(deps(), id, { kind: "delete", blockId: "S1" })).toEqual(refused);
  });
});
