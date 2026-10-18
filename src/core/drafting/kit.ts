import { z } from "zod";

import type { Role } from "@/core/extraction/record";
import { caseless } from "@/core/platform/caseless";

import { type FixedAnswer, type Topic, TOPICS } from "./topics";

/**
 * The email and message kits (drafting spec, "Draft structure"). The model
 * writes the fit table and the body as sentence blocks, each with its class
 * and the references it rests on, which live beside the text and never
 * inside it. Code writes every gap line, and for an email the subject, the
 * greeting and the closing; the Gmail app adds the owner's signature
 * (amendment A14), while a message ends with the profile's sign-off, which
 * code appends. The schema follows
 * the job record's rules for structured outputs: every field required, empty
 * values instead of nulls, no patterns or bounds, enum fields caseless.
 */

export const BLOCK_CLASSES = ["claim", "post", "gap", "courtesy"] as const;
export type BlockClass = (typeof BLOCK_CLASSES)[number];

export const VERDICTS = ["met", "partial", "gap"] as const;
export type Verdict = (typeof VERDICTS)[number];

const ids = (what: string) => z.array(z.string()).describe(what);

export const draftAnswerSchema = z.strictObject({
  fit: z
    .array(
      z.strictObject({
        requirement_id: z.string().describe("The requirement's ID from the post data, such as R1."),
        verdict: caseless(VERDICTS),
        fact_ids: ids("The IDs of the facts behind the verdict; empty for a gap."),
        note: z.string().describe("Why, in a few words."),
      }),
    )
    .describe("One row for each requirement of the role."),
  blocks: z
    .array(
      z.strictObject({
        id: z.string().describe("S1, S2, … in order."),
        text: z
          .string()
          .describe(
            "One sentence of the email's body; empty for a gap block, whose line code writes.",
          ),
        paragraph_break: z
          .boolean()
          .describe("Whether a new paragraph starts after this sentence."),
        class: caseless(BLOCK_CLASSES),
        fact_ids: ids("For a claim, the IDs of the facts it rests on; otherwise empty."),
        fields: ids(
          'For a post block, what it names from the post: "company.name", "title", or requirement IDs; otherwise empty.',
        ),
        gap: z
          .strictObject({
            requirement_id: z.string(),
            known_line_id: z.string(),
            template_id: z.string(),
            related_fact_id: z.string(),
          })
          .describe(
            "For a gap block: the must-have requirement it answers, and either a known gap line's ID, or a gap template's ID with one related fact's ID; an empty string for each it does not use. All empty for other blocks.",
          ),
      }),
    )
    .describe("The email's body, one sentence per block, in order."),
});

export type DraftAnswer = z.output<typeof draftAnswerSchema>;

/**
 * The model's answer for a form kit: the fit table, the cover note's blocks
 * as an email body's, and for each screening question it is shown, its
 * topic, the drafter's half of the two classifiers (drafting spec,
 * "Screening questions: fixed answers first"), and its answer to an
 * ordinary question, which code drops for a topic question.
 */
export const formAnswerSchema = draftAnswerSchema.extend({
  answers: z
    .array(
      z.strictObject({
        question_id: z.string().describe("The question's ID from the post data, such as Q1."),
        topic: caseless([...TOPICS, "none"] as const),
        text: z
          .string()
          .describe(
            "The job seeker's answer to an ordinary question; empty for a question with a topic, which code answers from their profile.",
          ),
        fact_ids: ids("The IDs of the facts the answer rests on; empty when the text is."),
      }),
    )
    .describe("One entry for each question in the post data, by its ID."),
});

export type FormDraftAnswer = z.output<typeof formAnswerSchema>;

/**
 * What a gap block answers and how its line was made. With no known line
 * and no template, code could not write the line: the block is the
 * owner's, "Needs your line" until they type it.
 */
export interface GapChoice {
  requirementId: string;
  knownLineId: string;
  templateId: string;
  relatedFactId: string;
}

export interface KitBlock {
  id: string;
  text: string;
  paragraphBreak: boolean;
  class: BlockClass;
  factIds: string[];
  fields: string[];
  /** For a gap block, the choice its line was built from. */
  gap: GapChoice | null;
  /**
   * The owner's own words, edited or added on the review page: validate
   * checks them for what they say, never against facts, which the owner
   * confirms instead. Absent on every drafted block.
   */
  owner?: true;
  /**
   * In a message kit, the other must-haves a merged gap line answers: lines
   * one template and one related fact build merge into one (drafting spec,
   * "Code-built parts"). Absent everywhere else.
   */
  alsoAnswers?: string[];
}

export interface EmailKit {
  kind: "email";
  subject: string;
  greeting: string;
  blocks: KitBlock[];
  closing: string;
}

/** A message's most characters, the sign-off included (drafting spec, "Draft structure"). */
export const MESSAGE_LIMIT = 600;

/**
 * The message kit, for WhatsApp and LinkedIn: the message's blocks, then the
 * profile's sign-off, which code appends.
 */
export interface MessageKit {
  kind: "message";
  blocks: KitBlock[];
  signOff: string;
}

/**
 * How a form's answer to a screening question came to be (drafting spec,
 * "Screening questions: fixed answers first"): from the profile, when both
 * classifiers name its topic; drafted, for an ordinary question; the
 * owner's to give, where the question or the profile lacks what the answer
 * needs, or the draft gave none; the owner's choice, when one classifier
 * names a topic, or the two differ; or never, for a question addressed to
 * AI.
 */
export type AnswerSource = "profile" | "drafted" | "needs_your_answer" | "choice" | "not_answered";

export interface FormAnswer {
  /** The question's ID in the post (Q1, …), which the owner's decisions name. */
  id: string;
  /** The question, on one line as the post asks it. */
  question: string;
  /** The topic a classifier named; null for an ordinary question. */
  topic: Topic | null;
  source: AnswerSource;
  /** The answer as it stands, the owner's words in place of any other's; empty while there is none. */
  text: string;
  /** For a drafted answer, the facts it rests on. */
  factIds: string[];
  /** For "needs_your_answer", why the owner must give it. */
  reason?: string;
  /** For a choice: the profile's answer to its topic, or why the owner must give one. */
  profile?: FixedAnswer;
  /** For a choice: the drafter's answer, when it wrote one. */
  drafted?: { text: string; factIds: string[] } | null;
  /** Code put the profile's answer in place of a drafted one (fixed_answer_drafted). */
  replaced?: true;
  /** The owner's own words, typed on the review page: checked for what they say, never against facts. */
  owner?: true;
}

/** The form kit: the cover note's blocks, and one answer for each screening question. */
export interface FormKit {
  kind: "form";
  blocks: KitBlock[];
  answers: FormAnswer[];
}

export type Kit = EmailKit | MessageKit | FormKit;

/** The kit as an email, for code that handles an email kit alone; any other is a mistake. */
export function asEmailKit(kit: Kit): EmailKit {
  if (kit.kind !== "email") throw new Error("An email kit was expected");
  return kit;
}

/**
 * The kit a route takes (drafting spec, "Kit type"); none for a route the
 * owner must name.
 */
export function kitTypeOf(route: Role["route"]["kind"]): "email" | "form" | "message" | null {
  switch (route) {
    case "email":
      return "email";
    case "ats_form":
    case "easy_apply":
    case "careers_page":
      return "form";
    case "whatsapp":
    case "linkedin_dm":
    case "linkedin_comment":
      return "message";
    case "other":
    case "unknown":
      return null;
  }
}

/** The must-haves a gap block answers: its own, and those a merged line answers too. */
export function answersOf(block: KitBlock): string[] {
  if (block.class !== "gap" || block.gap === null) return [];
  return [block.gap.requirementId, ...(block.alsoAnswers ?? [])];
}

export interface FitRow {
  requirementId: string;
  verdict: Verdict;
  factIds: string[];
  note: string;
}

/** The blocks as paragraphs: sentences joined by a space, each paragraph ending where a block says. */
function paragraphsOf(blocks: readonly KitBlock[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const block of blocks) {
    if (block.text !== "") current.push(block.text);
    if (block.paragraphBreak && current.length > 0) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs;
}

/** The email as the owner copies it: greeting, the body's paragraphs, closing. */
export function emailBody(kit: EmailKit): string {
  return [kit.greeting, ...paragraphsOf(kit.blocks), kit.closing].join("\n\n");
}

/** The message as the owner sends it: its paragraphs, then the sign-off, each after a blank line. */
export function messageText(kit: MessageKit): string {
  return [...paragraphsOf(kit.blocks), kit.signOff].filter((part) => part !== "").join("\n\n");
}

/** A form's cover note as it is pasted into its field: its paragraphs. */
export function coverNoteText(kit: FormKit): string {
  return paragraphsOf(kit.blocks).join("\n\n");
}

/**
 * The form as "Copy all" gives it (review spec, "Handoffs"): the cover note,
 * then each question with its answer, as labelled plain text, a question
 * with no answer left out.
 */
export function formText(kit: FormKit): string {
  const cover = coverNoteText(kit);
  const answered = kit.answers.filter((each) => each.text !== "");
  return [
    ...(cover === "" ? [] : [`Cover note\n${cover}`]),
    ...answered.map((each) => `${each.question}\n${each.text}`),
  ].join("\n\n");
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * A text's length in the characters a reader sees: an emoji is one, with
 * its skin tone, its variation selector or the parts a joiner joins, as a
 * flag is.
 */
export function visibleLength(text: string): number {
  return [...GRAPHEMES.segment(text)].length;
}

/** The message's length as its limit counts it: in characters, so an emoji is one. */
export function messageLength(kit: MessageKit): number {
  return visibleLength(messageText(kit));
}

/** Words in the body's blocks, as the word limit counts them. */
export function bodyWords(kit: Pick<Kit, "blocks">): number {
  return kit.blocks
    .map((block) => block.text)
    .join(" ")
    .split(/\s+/)
    .filter((word) => word !== "").length;
}
