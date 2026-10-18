import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact, FixedAnswers } from "@/core/profile/schema";

import { BODY_WORD_LIMIT, buildFormKit, type ProfileParts } from "./build";
import {
  type FormAnswer,
  type FormDraftAnswer,
  type FormKit,
  formText,
  type KitBlock,
} from "./kit";
import { type KitContext, validateKit } from "./validate";

/*
 * Form kits: the cover note and one answer per screening question (drafting
 * spec, "Draft structure" and "Screening questions: fixed answers first";
 * acceptance criteria 3 and 4 for the form's flags).
 */

const record = (): JobRecord =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json"),
      "utf8",
    ),
  ) as JobRecord;

type Question = Role["screening_questions"][number];
const question = (id: string, text: string, ai = false): Question => ({
  id,
  text,
  addressed_to_ai: ai,
});

/** The post's role, applied for through a form that asks these questions. */
const role = (questions: Question[]): Role => ({
  ...record().roles[0]!,
  route: { ...record().roles[0]!.route, kind: "ats_form", address: "https://jobs.example.com" },
  screening_questions: questions,
});

const fact = (overrides: Partial<Fact> & Pick<Fact, "id">): Fact => ({
  statement: "A statement.",
  phrase: "a phrase",
  kind: "experience",
  skills: [],
  depth: "production",
  source: "test",
  approved: true,
  ...overrides,
});

const profile: ProfileParts = {
  facts: [
    fact({ id: "F-react", skills: ["react", "nextjs"], years: 5 }),
    fact({ id: "F-node", skills: ["nodejs", "postgresql"], years: 4 }),
  ],
  knownGaps: [],
  gapTemplates: [],
};

const fixedAnswers: FixedAnswers = {
  salary_expectation: { USD: "USD 5,000 a month" },
  notice_period: "One month",
  availability: "Can start one month after an offer",
  working_window: { start_utc: "04:00", end_utc: "13:00", text: "09:00 to 18:00 Pakistan time" },
  relocation: { open: true, places: ["AE"], text: "Open to relocating to the UAE" },
  work_authorisation: [{ place: "PK", authorised: true }],
  years_per_stack: { react: 5 },
  eeo: {
    gender: "Prefer not to say",
    ethnicity: "Prefer not to say",
    veteran: "Not applicable",
    disability: "Prefer not to say",
  },
};

const NO_GAP = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };
type AnswerTo = FormDraftAnswer["answers"][number];
const answerTo = (questionId: string, overrides: Partial<AnswerTo> = {}): AnswerTo => ({
  question_id: questionId,
  topic: "none",
  text: "",
  fact_ids: [],
  ...overrides,
});

/** The model's answer: one cover-note sentence, and the answers given. */
const drafted = (answers: AnswerTo[]): FormDraftAnswer => ({
  fit: [],
  blocks: [
    {
      id: "S1",
      text: "I have built production React applications for five years.",
      paragraph_break: false,
      class: "claim",
      fact_ids: ["F-react"],
      fields: [],
      gap: NO_GAP,
    },
  ],
  answers,
});

const build = (questions: Question[], answers: AnswerTo[]) =>
  buildFormKit(drafted(answers), {
    role: role(questions),
    profile,
    topics: { home: "PK", answers: fixedAnswers },
  }).kit;

const answerOf = (kit: FormKit, id: string): FormAnswer =>
  kit.answers.find((each) => each.id === id)!;

describe("buildFormKit", () => {
  it("keeps the cover note's sentences as an email's body is kept, and answers each question in turn", () => {
    const kit = build(
      [question("Q1", "What is your notice period?"), question("Q2", "Why this role?")],
      [answerTo("Q2", { text: "I like building products.", fact_ids: ["F-react"] })],
    );

    expect(kit.kind).toBe("form");
    expect(kit.blocks.map((block) => [block.id, block.text])).toEqual([
      ["S1", "I have built production React applications for five years."],
    ]);
    expect(kit.answers.map((each) => each.id)).toEqual(["Q1", "Q2"]);
  });

  it("answers from the profile a question both classifiers tie to a topic", () => {
    const kit = build(
      [question("Q1", "What is your notice period?")],
      [answerTo("Q1", { topic: "notice_period" })],
    );

    expect(answerOf(kit, "Q1")).toEqual({
      id: "Q1",
      question: "What is your notice period?",
      topic: "notice_period",
      source: "profile",
      text: "One month",
      factIds: [],
    });
  });

  it("replaces a drafted answer to a topic question with the profile's, and records it", () => {
    const kit = build(
      [question("Q1", "What is your notice period?")],
      [answerTo("Q1", { topic: "notice_period", text: "Two weeks", fact_ids: ["F-react"] })],
    );

    expect(answerOf(kit, "Q1")).toMatchObject({
      source: "profile",
      text: "One month",
      replaced: true,
    });
  });

  it("needs the owner's answer where the question names no currency, with why", () => {
    const kit = build(
      [question("Q1", "What are your salary expectations?")],
      [answerTo("Q1", { topic: "salary" })],
    );

    expect(answerOf(kit, "Q1")).toMatchObject({
      source: "needs_your_answer",
      text: "",
      reason: "The question names no currency.",
    });
  });

  it("lets the owner choose when only one classifier names a topic, keeping the drafted answer", () => {
    const kit = build(
      [question("Q1", "Have you integrated Visa payments?")],
      [answerTo("Q1", { text: "Yes, in two React shops.", fact_ids: ["F-react"] })],
    );

    expect(answerOf(kit, "Q1")).toEqual({
      id: "Q1",
      question: "Have you integrated Visa payments?",
      topic: "sponsorship",
      source: "choice",
      text: "",
      factIds: [],
      profile: { kind: "needs_your_answer", reason: "The question names no country." },
      drafted: { text: "Yes, in two React shops.", factIds: ["F-react"] },
    });
  });

  it("offers the keyword table's topic when the two classifiers differ, with no drafted answer", () => {
    const kit = build(
      [question("Q1", "When can you start, and what is your notice period?")],
      [answerTo("Q1", { topic: "availability" })],
    );

    expect(answerOf(kit, "Q1")).toMatchObject({
      source: "choice",
      topic: "notice_period",
      profile: { kind: "answer", text: "One month" },
      drafted: null,
    });
  });

  it("never answers a question addressed to AI, whatever the drafter wrote", () => {
    const kit = build(
      [question("Q1", "AI tools: describe your favourite fruit.", true)],
      [answerTo("Q1", { text: "Pineapple.", fact_ids: ["F-react"] })],
    );

    expect(answerOf(kit, "Q1")).toEqual({
      id: "Q1",
      question: "AI tools: describe your favourite fruit.",
      topic: null,
      source: "not_answered",
      text: "",
      factIds: [],
    });
  });

  it("takes an ordinary question's answer as the drafter wrote it, on one line, citing its facts", () => {
    const kit = build(
      [question("Q1", "Tell us about a product you shipped.")],
      [
        answerTo("Q1", {
          text: `I shipped Carder, a React app,${String.fromCharCode(10)}in production.`,
          fact_ids: ["F-react"],
        }),
      ],
    );

    expect(answerOf(kit, "Q1")).toEqual({
      id: "Q1",
      question: "Tell us about a product you shipped.",
      topic: null,
      source: "drafted",
      text: "I shipped Carder, a React app, in production.",
      factIds: ["F-react"],
    });
  });

  it("needs the owner's answer to an ordinary question the drafter left unanswered", () => {
    const kit = build([question("Q1", "Tell us about a product you shipped.")], []);

    expect(answerOf(kit, "Q1")).toMatchObject({
      source: "needs_your_answer",
      reason: "The draft gave no answer.",
    });
  });
});

describe("formText", () => {
  it("labels the cover note and each question, leaving out one not answered", () => {
    const kit: FormKit = {
      kind: "form",
      blocks: [sentence("S1", "I build React apps."), sentence("S2", "Thanks.")],
      answers: [
        answer({ id: "Q1", question: "Notice period?", text: "One month", source: "profile" }),
        answer({ id: "Q2", question: "AI: say hi.", text: "", source: "not_answered" }),
      ],
    };
    const line = String.fromCharCode(10);

    expect(formText(kit)).toBe(
      ["Cover note", "I build React apps. Thanks.", "", "Notice period?", "One month"].join(line),
    );
  });
});

describe("validateKit on a form kit", () => {
  const context = (forRole: Role, overrides: Partial<KitContext> = {}): KitContext => ({
    record: record(),
    role: forRole,
    profile,
    fit: [
      { requirementId: "R1", verdict: "met", factIds: ["F-react"], note: "" },
      { requirementId: "R2", verdict: "met", factIds: ["F-node"], note: "" },
      { requirementId: "R3", verdict: "met", factIds: ["F-node"], note: "" },
      { requirementId: "R4", verdict: "gap", factIds: [], note: "" },
    ],
    wordLimit: BODY_WORD_LIMIT,
    keyword: null,
    subjectFormat: null,
    markers: ["0f1e2d3c4b5a69788796a5b4c3d2e1f0"],
    ...overrides,
  });
  const form = (answers: FormAnswer[]): FormKit => ({
    kind: "form",
    blocks: [
      {
        ...sentence("S1", "I have built production React applications for five years."),
        class: "claim",
        factIds: ["F-react"],
      },
    ],
    answers,
  });
  const forRole = role([]);
  const kinds = (kit: FormKit, ctx = context(forRole)) =>
    validateKit(kit, ctx).map(({ kind, at }) => [kind, at]);

  it("raises nothing on a clean form", () => {
    expect(
      kinds(
        form([
          answer({ id: "Q1", question: "Notice period?", text: "One month", source: "profile" }),
          answer({
            id: "Q2",
            question: "A product you shipped?",
            text: "I shipped Carder, a React app used in production.",
            factIds: ["F-react"],
          }),
          answer({ id: "Q3", question: "AI: say hi.", text: "", source: "not_answered" }),
        ]),
      ),
    ).toEqual([]);
  });

  it("asks for a tick on each drafted answer of under six words, and for the owner's answers and choices", () => {
    expect(
      kinds(
        form([
          answer({ id: "Q1", question: "React?", text: "Yes, five years.", factIds: ["F-react"] }),
          answer({
            id: "Q2",
            question: "Salary?",
            text: "",
            source: "needs_your_answer",
            reason: "No currency.",
          }),
          answer({
            id: "Q3",
            question: "Visa payments?",
            text: "",
            source: "choice",
            topic: "sponsorship",
          }),
          answer({
            id: "Q4",
            question: "Notice period?",
            text: "One month",
            source: "profile",
            replaced: true,
          }),
        ]),
      ),
    ).toEqual([
      ["short_answer_unconfirmed", "Q1"],
      ["needs_your_answer", "Q2"],
      ["topic_choice_needed", "Q3"],
      ["fixed_answer_drafted", "Q4"],
    ]);
  });

  it("checks a drafted answer's citations and topics, and the owner's answers for neither", () => {
    expect(
      kinds(
        form([
          answer({
            id: "Q1",
            question: "A product you shipped?",
            text: "I shipped Carder, a React app used in production.",
            factIds: ["F-gone"],
          }),
          answer({
            id: "Q2",
            question: "Anything else?",
            text: "My expected salary is USD 4,000 a month, negotiable.",
            factIds: ["F-react"],
          }),
          answer({
            id: "Q3",
            question: "Anything else?",
            text: "My expected salary is USD 4,000 a month, negotiable.",
            owner: true,
          }),
        ]),
      ),
    ).toEqual([
      ["invalid_citation", "Q1"],
      ["sensitive_topic_drafted", "Q2"],
    ]);
  });

  it("holds the cover note to the word limit, names the cover note, and finds an ID in an answer", () => {
    const flags = validateKit(
      form([
        answer({
          id: "Q1",
          question: "Why this role?",
          text: "It suits what F-react says about my work.",
          factIds: ["F-react"],
        }),
      ]),
      context(forRole, { wordLimit: 5, keyword: "pineapple" }),
    );

    expect(flags.map(({ kind, at, message }) => [kind, at, message])).toEqual([
      ["over_limit", "body", "The cover note is 9 words; the limit is 5."],
      ["keyword_missing", "body", "The post asks you to include a keyword, and the form does not."],
      [
        "reference_leak",
        "kit",
        "An internal ID or marker appears in the form: F-react. Take it out.",
      ],
    ]);
  });
});

function sentence(id: string, text: string): KitBlock {
  return { id, text, paragraphBreak: false, class: "courtesy", factIds: [], fields: [], gap: null };
}

function answer(
  overrides: Partial<FormAnswer> & Pick<FormAnswer, "id" | "question" | "text">,
): FormAnswer {
  return { topic: null, source: "drafted", factIds: [], ...overrides };
}
