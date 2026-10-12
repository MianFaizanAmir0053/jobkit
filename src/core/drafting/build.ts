import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact, GapTemplate, KnownGap } from "@/core/profile/schema";
import { skillName } from "@/core/shared/skills";

import type { DraftAnswer, EmailKit, FitRow, GapChoice, KitBlock } from "./kit";

/**
 * The parts of an email kit code writes (drafting spec, "Code-built parts"
 * and "Accepted instructions"): the subject, the greeting, every gap line and
 * the closing, and which of the post's instructions code acts on. Every
 * string taken from the post loses its control characters here, so none can
 * break a line in a subject or a header.
 */

export const NEEDS_YOUR_LINE = "Needs your line";
export const DEFAULT_GREETING = "Dear Hiring Team,";
export const CLOSING = "Kind regards,";
export const BODY_WORD_LIMIT = 180;
const KEYWORD_MAX_LENGTH = 40;

type Requirement = Role["requirements"][number];

export interface ProfileParts {
  facts: readonly Fact[];
  knownGaps: readonly KnownGap[];
  gapTemplates: readonly GapTemplate[];
}

/** What code takes from the post's instructions; never one addressed to AI. */
export interface Accepted {
  subjectFormat: string | null;
  /** The body's limit in words: 180, or less when the post asks for less. */
  wordLimit: number;
  keyword: string | null;
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** The text on one line: every control character, carriage returns and line feeds among them, becomes a space. */
export function oneLine(text: string): string {
  return [...text]
    .map((char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

const LINK = /https?:|:\/\/|www\./i;

export function acceptedInstructions(role: Role): Accepted {
  const usable = role.instructions.filter((instruction) => !instruction.addressed_to_ai);
  const subject = usable.find(
    (instruction) => instruction.kind === "subject_format" && oneLine(instruction.value) !== "",
  );
  const limits = usable
    .filter((instruction) => instruction.kind === "word_limit")
    .map((instruction) => Number(/\d+/.exec(instruction.value)?.[0]))
    .filter((limit) => Number.isInteger(limit) && limit > 0);
  const keyword = usable.find(
    (instruction) =>
      instruction.kind === "include_keyword" &&
      oneLine(instruction.value) === instruction.value.trim() &&
      instruction.value.trim() !== "" &&
      [...instruction.value.trim()].length <= KEYWORD_MAX_LENGTH &&
      !LINK.test(instruction.value),
  );
  return {
    subjectFormat: subject ? subject.value : null,
    wordLimit: Math.min(BODY_WORD_LIMIT, ...limits),
    keyword: keyword ? keyword.value.trim() : null,
  };
}

/** The post's format with only {name} and {role} filled in, or "Application: {Role} – {Name}". */
export function subjectFor(format: string | null, ownerName: string, roleTitle: string): string {
  const title = oneLine(roleTitle);
  const filled =
    format === null
      ? `Application: ${title} – ${ownerName}`
      : format.replaceAll("{name}", ownerName).replaceAll("{role}", title);
  return oneLine(filled);
}

export function greetingFor(recruiterName: string): string {
  const name = oneLine(recruiterName);
  return name === "" ? DEFAULT_GREETING : `Dear ${name},`;
}

/**
 * A gap line, written by code: a known gap line verbatim, or a template with
 * {skill} as the requirement's first skill's name and {related} as the
 * related fact's phrase. "Needs your line" when neither can be built: a
 * requirement with no skill tag, or a choice naming nothing the profile has.
 */
export function gapLine(
  requirement: Requirement | undefined,
  choice: GapChoice,
  profile: ProfileParts,
): string {
  const known = profile.knownGaps.find((gap) => gap.id === choice.knownLineId);
  if (known) return known.line;
  const skill = requirement?.skills[0];
  const template = profile.gapTemplates.find((entry) => entry.id === choice.templateId);
  if (skill === undefined || !template) return NEEDS_YOUR_LINE;
  const related = profile.facts.find((fact) => fact.id === choice.relatedFactId);
  if (template.text.includes("{related}") && !related) return NEEDS_YOUR_LINE;
  return template.text
    .replaceAll("{skill}", skillName(skill))
    .replaceAll("{related}", related?.phrase ?? "");
}

/** The kit from the model's answer: its blocks as written, gap lines by code, and the parts code writes. */
export function buildEmailKit(
  answer: DraftAnswer,
  context: {
    record: JobRecord;
    role: Role;
    ownerName: string;
    accepted: Accepted;
    profile: ProfileParts;
  },
): { kit: EmailKit; fit: FitRow[] } {
  const { record, role, ownerName, accepted, profile } = context;
  const blocks: KitBlock[] = answer.blocks.map((block) => {
    const gap: GapChoice | null =
      block.class === "gap"
        ? {
            requirementId: block.gap.requirement_id,
            knownLineId: block.gap.known_line_id,
            templateId: block.gap.template_id,
            relatedFactId: block.gap.related_fact_id,
          }
        : null;
    const requirement = role.requirements.find((entry) => entry.id === gap?.requirementId);
    return {
      id: block.id,
      text: gap ? gapLine(requirement, gap, profile) : oneLine(block.text),
      paragraphBreak: block.paragraph_break,
      class: block.class,
      factIds: block.fact_ids,
      fields: block.fields,
      gap,
    };
  });
  return {
    kit: {
      kind: "email",
      subject: subjectFor(accepted.subjectFormat, ownerName, role.title),
      greeting: greetingFor(record.recruiter.name),
      blocks,
      closing: CLOSING,
    },
    fit: answer.fit.map((row) => ({
      requirementId: row.requirement_id,
      verdict: row.verdict,
      factIds: row.fact_ids,
      note: row.note,
    })),
  };
}
