import { z } from "zod";

import { caseless } from "@/core/platform/caseless";

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

export type Kit = EmailKit | MessageKit;

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

/** The message's length as its limit counts it: in characters, so an emoji is one. */
export function messageLength(kit: MessageKit): number {
  return [...messageText(kit)].length;
}

/** Words in the body's blocks, as the word limit counts them. */
export function bodyWords(kit: EmailKit): number {
  return kit.blocks
    .map((block) => block.text)
    .join(" ")
    .split(/\s+/)
    .filter((word) => word !== "").length;
}
