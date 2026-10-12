import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact, GapTemplate, KnownGap } from "@/core/profile/schema";
import { skillName, skillTag } from "@/core/shared/skills";

import type { DraftAnswer, EmailKit, FitRow, GapChoice, KitBlock } from "./kit";

/**
 * The parts of an email kit code writes (drafting spec, "Code-built parts"
 * and "Accepted instructions"): the subject, the greeting, every gap line and
 * the closing, and which of the post's instructions code acts on. Every
 * string taken from the post loses its control and format characters here
 * (direction marks, zero-width spaces), so none can break a line in a
 * subject or a header, make one read otherwise than it is sent, or hide a
 * word from a check.
 */

export const NEEDS_YOUR_LINE = "Needs your line";
export const DEFAULT_GREETING = "Dear Hiring Team,";
export const CLOSING = "Kind regards,";
export const BODY_WORD_LIMIT = 180;
const KEYWORD_MAX_LENGTH = 40;

type Requirement = Role["requirements"][number];
type Instruction = Role["instructions"][number];

export interface ProfileParts {
  facts: readonly Fact[];
  knownGaps: readonly KnownGap[];
  gapTemplates: readonly GapTemplate[];
}

/** What code takes from the post's instructions; never one addressed to AI. */
export interface Accepted {
  subjectFormat: string | null;
  /** The body's limit in words: 180, or less when the post asks for fewer words. */
  wordLimit: number;
  keyword: string | null;
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** Format characters: direction marks and isolates, zero-width spaces and joiners, a byte-order mark. */
const FORMAT = /^\p{Cf}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);

/** A variation selector or a skin tone, which may sit between an emoji and a joiner. */
function isEmojiModifier(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code === 0xfe0e || code === 0xfe0f || (code >= 0x1f3fb && code <= 0x1f3ff);
}

/** Whether the joiner at `i` joins two emoji, as in a family or a profession emoji. */
function joinsEmoji(chars: readonly string[], i: number): boolean {
  let before = i - 1;
  while (before >= 0 && isEmojiModifier(chars[before]!)) before--;
  return before >= 0 && PICTOGRAPH.test(chars[before]!) && PICTOGRAPH.test(chars[i + 1] ?? "");
}

/**
 * The text on one line: every control character, carriage returns and line
 * feeds among them, becomes a space, and format characters go, except a
 * joiner inside an emoji.
 */
export function oneLine(text: string): string {
  const chars = [...text];
  return chars
    .map((char, i) => {
      if (isControl(char.codePointAt(0)!)) return " ";
      if (!FORMAT.test(char)) return char;
      return char === ZERO_WIDTH_JOINER && joinsEmoji(chars, i) ? char : "";
    })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** A skill tag as the shared vocabulary writes it: "k8s" is kubernetes. */
export function canonicalSkill(tag: string): string {
  return skillTag(tag) ?? tag;
}

const LINK = /https?:|:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\//i;
const WORDS = /(\d[\d,]*)\s*words?\b/i;
const BARE_NUMBER = /^\s*(\d[\d,]*)\s*$/;
/** Words before a number that make it a least, not a most: "at least 100 words", "a minimum of 100 words". */
const MINIMUM_BEFORE = /\b(?:at least|min(?:imum)?(?: of)?\.?|no (?:fewer|less) than)\s*$/i;

/**
 * The most words an instruction allows: its value when that is a bare
 * number, else the first "N words" in its value, then in its text. None for
 * a least ("at least 100 words") or a limit in other units ("one page",
 * "500 characters"), which stay on the checklist.
 */
function wordLimitOf(instruction: Instruction): number | null {
  const bare = BARE_NUMBER.exec(instruction.value)?.[1];
  const found =
    bare === undefined
      ? [instruction.value, instruction.text]
          .map((text) => ({ text, match: WORDS.exec(text) }))
          .find(({ match }) => match !== null)
      : undefined;
  if (found?.match && MINIMUM_BEFORE.test(found.text.slice(0, found.match.index))) return null;
  const words = Number((bare ?? found?.match?.[1])?.replaceAll(",", ""));
  return Number.isInteger(words) && words > 0 ? words : null;
}

export function acceptedInstructions(role: Role): Accepted {
  const usable = role.instructions.filter((instruction) => !instruction.addressed_to_ai);
  const subject = usable.find(
    (instruction) => instruction.kind === "subject_format" && oneLine(instruction.value) !== "",
  );
  // Only a most in words tightens the body's limit.
  const limits = usable
    .filter((instruction) => instruction.kind === "word_limit")
    .map(wordLimitOf)
    .filter((limit) => limit !== null);
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
  // Function replacements, so a "$&" in a title or a name is only text.
  const filled =
    format === null
      ? `Application: ${title} – ${ownerName}`
      : format.replaceAll("{name}", () => ownerName).replaceAll("{role}", () => title);
  return oneLine(filled);
}

export function greetingFor(recruiterName: string): string {
  const name = oneLine(recruiterName);
  return name === "" ? DEFAULT_GREETING : `Dear ${name},`;
}

/** Whether a kind of requirement can take a template: a degree, a language or "other" cannot. */
function takesTemplate(requirement: Requirement): boolean {
  return requirement.kind === "skill" || requirement.kind === "experience";
}

/** Whether a known gap line speaks to this requirement: it names one of its skills. */
export function knownLineFits(known: KnownGap, requirement: Requirement): boolean {
  const skills = requirement.skills.map(canonicalSkill);
  return known.skills.some((skill) => skills.includes(skill));
}

/**
 * A gap line, written by code (the owner's rule of 2026-10-12): a known gap
 * line naming one of the requirement's skills, verbatim; or, for a skill or
 * experience requirement, a template with {skill} as the first of its
 * skills that no approved fact has, so a line never says the owner lacks a
 * skill the profile shows, and {related} as the related fact's phrase.
 * "Needs your line" when neither can be built: a degree, a language or an
 * "other" requirement, every skill shown somewhere, or a choice naming
 * nothing the profile has.
 */
export function gapLine(
  requirement: Requirement | undefined,
  choice: GapChoice,
  profile: ProfileParts,
): string {
  if (!requirement) return NEEDS_YOUR_LINE;
  const known = profile.knownGaps.find((gap) => gap.id === choice.knownLineId);
  if (known && knownLineFits(known, requirement)) return known.line;
  const template = profile.gapTemplates.find((entry) => entry.id === choice.templateId);
  if (!template || !takesTemplate(requirement)) return NEEDS_YOUR_LINE;
  const lacking = requirement.skills
    .map(canonicalSkill)
    .find((skill) => !profile.facts.some((fact) => fact.skills.includes(skill)));
  if (lacking === undefined) return NEEDS_YOUR_LINE;
  const related = profile.facts.find((fact) => fact.id === choice.relatedFactId);
  if (template.text.includes("{related}") && !related) return NEEDS_YOUR_LINE;
  return oneLine(
    template.text
      .replaceAll("{skill}", () => oneLine(skillName(lacking)))
      .replaceAll("{related}", () => related?.phrase ?? ""),
  );
}

/**
 * The kit from the model's answer: its blocks as written, with IDs by
 * position, gap lines by code, and the parts code writes.
 */
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
  const blocks: KitBlock[] = answer.blocks.map((block, i) => {
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
      id: `S${i + 1}`,
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
