import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact, GapTemplate, KnownGap } from "@/core/profile/schema";
import { EMAIL_BODY_WORD_LIMIT } from "@/core/shared/email";
import { skillName, skillTag } from "@/core/shared/skills";

import type { DraftAnswer, EmailKit, FitRow, GapChoice, KitBlock } from "./kit";

/**
 * The parts of an email kit code writes (drafting spec, "Code-built parts"
 * and "Accepted instructions"): the subject, the greeting, every gap line and
 * the closing, and which of the post's instructions code acts on. Every
 * string taken from the post loses its control characters and the
 * characters that show nothing (direction marks, zero-width spaces and
 * joiners, fillers), and its unusual spaces become plain ones, so none can
 * break a line in a subject or a header, make one read otherwise than it
 * is sent, or hide a word from a check.
 */

export const NEEDS_YOUR_LINE = "Needs your line";
export const DEFAULT_GREETING = "Dear Hiring Team,";
export const CLOSING = "Kind regards,";
export const BODY_WORD_LIMIT = EMAIL_BODY_WORD_LIMIT;
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

/**
 * Characters that show nothing: format characters (direction marks, a
 * byte-order mark) and every default-ignorable one (zero-width spaces and
 * joiners, variation selectors, fillers, tag characters).
 */
const INVISIBLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
/** Spaces other than the plain one: no-break, narrow, ideographic and the rest. */
const SPACE = /^\p{Zs}$/u;
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

/** Whether an invisible character is part of an emoji: a joiner between two, or a variation selector after one. */
function partOfEmoji(chars: readonly string[], i: number): boolean {
  if (chars[i] === ZERO_WIDTH_JOINER) return joinsEmoji(chars, i);
  return isEmojiModifier(chars[i]!) && i > 0 && PICTOGRAPH.test(chars[i - 1]!);
}

/**
 * The text on one line: every control character, carriage returns and line
 * feeds among them, and every unusual space become a plain space, and the
 * characters that show nothing go, except those inside an emoji.
 */
export function oneLine(text: string): string {
  const chars = [...text];
  return chars
    .map((char, i) => {
      if (isControl(char.codePointAt(0)!) || SPACE.test(char)) return " ";
      if (!INVISIBLE.test(char)) return char;
      return partOfEmoji(chars, i) ? char : "";
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
const WORDS = /(\d[\d,]*)\s*words?\b/gi;
const BARE_NUMBER = /^\s*(\d[\d,]*)\s*$/;
/** Units a limit may be in other than words: such a limit stays on the checklist. */
const OTHER_UNIT =
  /\b(?:pages?|characters?|chars?|letters?|lines?|paragraphs?|sentences?|bullets?|slides?|minutes?)\b/i;
/** Words before a number that make it a least: "at least 100", "a minimum of 100", "not less than 100", "more than 100". */
const LEAST_BEFORE =
  /(?:\bat least|\bmin(?:imum)?(?: of)?[.:]?|\b(?:not|no) (?:less|fewer) than|(?<!\bno )\bmore than)\s*$/i;
/** Words after "N words" that make it a least: "100 words minimum", "100 words or more". */
const LEAST_AFTER = /^\s*(?:\+|minimum\b|min\b|or more\b|at least\b)/i;

const wholeNumber = (digits: string) => Number(digits.replaceAll(",", ""));

/** Whether the number at `at` in `text`, `length` long, is a least. */
function isLeast(text: string, at: number, length: number): boolean {
  return LEAST_BEFORE.test(text.slice(0, at)) || LEAST_AFTER.test(text.slice(at + length));
}

/**
 * The most words an instruction allows. Its value as a bare number, unless
 * its text puts that number in other units ("Max 2 pages") or makes it a
 * least ("at least 100 words"); otherwise the smallest "N words" in its
 * value and text that is not a least ("Min 50 words, max 120 words" is
 * 120). None when nothing is left, so the limit stays on the checklist.
 */
export function wordLimitOf(instruction: Instruction): number | null {
  const { value, text } = instruction;
  const bare = BARE_NUMBER.exec(value)?.[1];
  if (bare !== undefined) {
    if (OTHER_UNIT.test(text) && !/\bwords?\b/i.test(text)) return null;
    const mentions = [...text.matchAll(new RegExp(`(?<![\\d,])${bare}(?![\\d,])`, "g"))];
    if (mentions.some((mention) => isLeast(text, mention.index, mention[0].length))) return null;
    const words = wholeNumber(bare);
    return words > 0 ? words : null;
  }
  const mosts = [value, text].flatMap((part) =>
    [...part.matchAll(WORDS)]
      .filter((match) => !isLeast(part, match.index, match[0].length))
      .map((match) => wholeNumber(match[1]!)),
  );
  const words = mosts.filter((count) => count > 0);
  return words.length > 0 ? Math.min(...words) : null;
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
  // A keyword as it shows, on one line as the post wrote it, short and with no link.
  const keyword = usable.find(
    (instruction) =>
      instruction.kind === "include_keyword" &&
      ![...instruction.value].some((char) => isControl(char.codePointAt(0)!)) &&
      oneLine(instruction.value) !== "" &&
      [...oneLine(instruction.value)].length <= KEYWORD_MAX_LENGTH &&
      !LINK.test(instruction.value),
  );
  return {
    subjectFormat: subject ? subject.value : null,
    wordLimit: Math.min(BODY_WORD_LIMIT, ...limits),
    keyword: keyword ? oneLine(keyword.value) : null,
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

/**
 * Letters a name carries after it, as people write them, dots aside: a
 * greeting leaves them out. Matched as written, so a surname such as "Ma"
 * is never taken for an MA.
 */
const CREDENTIALS: ReadonlySet<string> = new Set([
  ...["MBA", "PMP", "PhD", "PHD", "MSc", "MSC", "MS", "MA", "BSc", "BSC", "BS", "BA", "MEng"],
  ...["MD", "JD", "LLB", "LLM", "CPA", "CFA", "ACCA", "ACA", "CIMA"],
  ...["SHRM-CP", "SHRM-SCP", "PHR", "SPHR", "CIPD", "CHRP", "CSM", "CSPO", "PSM"],
]);

/**
 * The person the post names, as a greeting addresses them: the name before
 * any comma, bar, bracket or spaced dash that adds credentials, pronouns or
 * a job title ("Tamer Omar, MBA, PMP", "Sarah Lee (She/Her)", "Mike Ross |
 * Talent Acquisition"), without emoji or credentials after it, and the
 * hiring team when no name is left.
 */
export function greetingFor(recruiterName: string): string {
  const name = oneLine(recruiterName)
    .split(/\s*(?:[,|(•·]|\s[-–—]\s)/u)[0]!
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .trim();
  const words = name.split(/\s+/).filter(Boolean);
  while (words.length > 0 && CREDENTIALS.has(words.at(-1)!.replaceAll(".", ""))) words.pop();
  return words.length === 0 ? DEFAULT_GREETING : `Dear ${words.join(" ")},`;
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
    const text = gap ? gapLine(requirement, gap, profile) : oneLine(block.text);
    return {
      id: `S${i + 1}`,
      text,
      paragraphBreak: block.paragraph_break,
      class: block.class,
      factIds: block.fact_ids,
      fields: block.fields,
      // A line code could not write keeps no line choice: it is the owner's to write (kit.ts).
      gap:
        gap && text === NEEDS_YOUR_LINE
          ? { ...gap, knownLineId: "", templateId: "", relatedFactId: "" }
          : gap,
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
