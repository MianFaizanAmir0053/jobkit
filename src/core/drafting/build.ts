import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact, GapTemplate, KnownGap } from "@/core/profile/schema";
import { EMAIL_BODY_WORD_LIMIT } from "@/core/shared/email";
import { skillName, skillTag } from "@/core/shared/skills";

import type {
  DraftAnswer,
  EmailKit,
  FitRow,
  FormAnswer,
  FormDraftAnswer,
  FormKit,
  GapChoice,
  Kit,
  KitBlock,
  MessageKit,
} from "./kit";
import { decideTopic, fixedAnswer, keywordTopic, type TopicProfile } from "./topics";

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

/** How code wrote a gap line: a known line, a template (naming one skill), or none, for the owner to write. */
type MadeLine =
  | { made: "known"; text: string }
  | { made: "template"; text: string; skill: string }
  | { made: "owner"; text: typeof NEEDS_YOUR_LINE };

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
  return madeLine(requirement, choice, profile).text;
}

function madeLine(
  requirement: Requirement | undefined,
  choice: GapChoice,
  profile: ProfileParts,
): MadeLine {
  const owners = { made: "owner", text: NEEDS_YOUR_LINE } as const;
  if (!requirement) return owners;
  const known = profile.knownGaps.find((gap) => gap.id === choice.knownLineId);
  if (known && knownLineFits(known, requirement)) return { made: "known", text: known.line };
  const template = profile.gapTemplates.find((entry) => entry.id === choice.templateId);
  if (!template || !takesTemplate(requirement)) return owners;
  const lacking = requirement.skills
    .map(canonicalSkill)
    .find((skill) => !profile.facts.some((fact) => fact.skills.includes(skill)));
  if (lacking === undefined) return owners;
  const related = profile.facts.find((fact) => fact.id === choice.relatedFactId);
  if (template.text.includes("{related}") && !related) return owners;
  return { made: "template", text: filled(template.text, [lacking], related), skill: lacking };
}

/**
 * Whether a template's line can stand for several must-haves: one naming
 * no skill, whose lines read alike, or one naming its {skill} once, in a
 * clause that denies it ("I haven't used {skill}"), where a list joined by
 * "or" reads true; never with "neither", whose list wants "nor". Another
 * template keeps a line for each must-have, as an email's does.
 */
function listable(template: string): boolean {
  const places = template.split("{skill}");
  if (places.length === 1) return true;
  if (places.length > 2) return false;
  // The clause the skill sits in, from the last break before it; a word after it that refers back
  // to it would refer to the list ("…at work, but I use it daily").
  const clause = places[0]!.split(CLAUSE_BREAK).at(-1)!;
  return NEGATION.test(clause) && !/\bneither\b/i.test(clause) && !BACK_REFERENCE.test(places[1]!);
}

/**
 * Where one clause ends and the next begins: a mark, a dash, or a word that
 * joins two clauses ("No production use yet but I have used {skill}").
 */
const CLAUSE_BREAK =
  /[,;:.()!?—–]|\s-\s|\b(?:but|and|so|though|although|while|whereas|because|since|unless|yet(?!\s+to\b))\b/i;

/** Words that refer back to what came before, as to a skill a list would stand in for. */
const BACK_REFERENCE = /\b(?:it|its|them|they|their|this|that|these|those)\b/i;

/** Words that deny what follows them in a clause: "I haven't used {skill}", "I cannot claim {skill}". */
const NEGATION = /\b(?:not|never|no|cannot|without|lack|lacking|yet to)\b|n['’]t\b/i;

/**
 * A template with {skill} as the skills' display names, listed ("A", "A or
 * B", "A, B or C": only a clause that denies them lists several), and
 * {related} as the related fact's phrase.
 */
function filled(template: string, skills: readonly string[], related: Fact | undefined): string {
  const names = skills.map((skill) => oneLine(skillName(skill)));
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)!}` : names.join("");
  return oneLine(
    template.replaceAll("{skill}", () => list).replaceAll("{related}", () => related?.phrase ?? ""),
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
  return {
    kit: {
      kind: "email",
      subject: subjectFor(accepted.subjectFormat, ownerName, role.title),
      greeting: greetingFor(record.recruiter.name),
      blocks: blocksOf(answer, role, profile),
      closing: CLOSING,
    },
    fit: fitOf(answer),
  };
}

/**
 * The message kit from the model's answer (drafting spec, "Draft
 * structure"): its blocks as an email's are built, with the gap lines one
 * template and one related fact build merged into one, so the message's 600
 * characters can hold them, and the profile's sign-off after them.
 */
export function buildMessageKit(
  answer: DraftAnswer,
  context: { role: Role; signOff: string; profile: ProfileParts },
): { kit: MessageKit; fit: FitRow[] } {
  const { role, signOff, profile } = context;
  const blocks = merged(blocksOf(answer, role, profile), role, profile).map((block, i) => ({
    ...block,
    id: `S${i + 1}`,
  }));
  return { kit: { kind: "message", blocks, signOff: signOff.trim() }, fit: fitOf(answer) };
}

/**
 * The form kit from the model's answer (drafting spec, "Draft structure"
 * and "Screening questions: fixed answers first"): the cover note's blocks
 * as an email body's are built, and an answer for each of the role's
 * screening questions in turn. Both classifiers naming one topic, code
 * answers from the profile, and a drafted answer it puts aside is recorded
 * (`replaced`); one classifier, or two that differ, the owner chooses,
 * offered the keyword table's topic; a question addressed to AI is never
 * answered; an ordinary one takes the drafter's answer, on one line, citing
 * its facts. The model never writes a topic question's answer.
 */
export function buildFormKit(
  answer: FormDraftAnswer,
  context: {
    role: Role;
    profile: ProfileParts;
    topics: TopicProfile;
    /** The questions kept from the drafter, as they repeat a line aimed at AI: the owner's to answer. */
    held?: ReadonlySet<string>;
  },
): { kit: FormKit; fit: FitRow[] } {
  const { role, profile, topics } = context;
  const given = new Map(answer.answers.map((each) => [each.question_id, each]));
  const answers = role.screening_questions.map((question): FormAnswer => {
    const base = { id: question.id, question: oneLine(question.text), factIds: [] as string[] };
    if (!question.addressed_to_ai && context.held?.has(question.id)) {
      return {
        ...base,
        topic: null,
        source: "needs_your_answer",
        text: "",
        reason: "jobkit kept it from the drafter, as it repeats a line aimed at AI tools.",
      };
    }
    const fromModel = given.get(question.id);
    const text = fromModel ? oneLine(fromModel.text) : "";
    const drafterTopic = fromModel && fromModel.topic !== "none" ? fromModel.topic : null;
    // The drafter's words count only where it took the question as ordinary: it leaves a topic's
    // answer to code.
    const drafted =
      text === "" || drafterTopic !== null ? null : { text, factIds: fromModel!.fact_ids };
    const decision = decideTopic(question, drafterTopic);
    switch (decision.kind) {
      case "not_answered":
        return { ...base, topic: null, source: "not_answered", text: "" };
      case "fixed": {
        // Read on one line, as the page shows it and withCodeParts reads it again. Words the
        // drafter wrote are recorded put aside even where the owner answers, so a fix that lets
        // the profile answer later still flags them.
        const fixed = fixedAnswer(decision.topic, base.question, topics);
        const putAside = text !== "" ? { replaced: true as const } : {};
        return fixed.kind === "needs_your_answer"
          ? {
              ...base,
              topic: decision.topic,
              source: "needs_your_answer",
              text: "",
              reason: fixed.reason,
              ...putAside,
            }
          : { ...base, topic: decision.topic, source: "profile", text: fixed.text, ...putAside };
      }
      case "choice":
        return {
          ...base,
          topic: decision.topic,
          source: "choice",
          text: "",
          profile: fixedAnswer(decision.topic, base.question, topics),
          drafted,
        };
      case "ordinary":
        return drafted
          ? {
              ...base,
              topic: null,
              source: "drafted",
              text: drafted.text,
              factIds: drafted.factIds,
            }
          : {
              ...base,
              topic: null,
              source: "needs_your_answer",
              text: "",
              reason: "The draft gave no answer.",
            };
    }
  });
  return {
    kit: { kind: "form", blocks: blocksOf(answer, role, profile), answers },
    fit: fitOf(answer),
  };
}

/**
 * A stored kit with the parts code builds from the profile built again by
 * the code as it stands, so a kit drafted before a fix to them reads as the
 * fixed code builds it: a form's answers from the profile (each topic
 * question's, and a choice's profile answer, as fixedAnswer gives them now),
 * and a public comment's sign-off, the owner's name alone. The drafter's
 * words, and an answer code never took from the profile, stay as they were,
 * but for a choice's drafted words where the keyword table names no topic or
 * another: the drafter named the topic, so they are its words for a topic
 * question, which a build before e7ea758 kept.
 */
export function withCodeParts(
  kit: Kit,
  context: { route: Role["route"]["kind"]; owner: string; topics: TopicProfile },
): Kit {
  if (kit.kind === "message") {
    return context.route === "linkedin_comment" ? { ...kit, signOff: context.owner } : kit;
  }
  if (kit.kind !== "form") return kit;
  const answers = kit.answers.map((answer): FormAnswer => {
    if (answer.topic === null) return answer;
    const fixed = fixedAnswer(answer.topic, answer.question, context.topics);
    if (answer.source === "choice") {
      const drafted = keywordTopic(answer.question) === answer.topic ? answer.drafted : null;
      return { ...answer, profile: fixed, drafted };
    }
    if (answer.source !== "profile" && answer.source !== "needs_your_answer") return answer;
    // A reason belongs to an answer the owner must give alone.
    const rest = { ...answer };
    delete rest.reason;
    return fixed.kind === "answer"
      ? { ...rest, source: "profile", text: fixed.text }
      : { ...rest, source: "needs_your_answer", text: "", reason: fixed.reason };
  });
  return { ...kit, answers };
}

/**
 * A message's gap lines merged: the lines one template and one related fact
 * build (any related fact, for a template that names none) become one, in
 * the first one's place, naming each skill once and answering each of their
 * must-haves. A known line, the owner's line and a
 * line of another template or related fact keep their own words. Where a
 * merged line ended a paragraph, the sentence before it ends it instead.
 */
function merged(blocks: readonly KitBlock[], role: Role, profile: ProfileParts): KitBlock[] {
  const groups = new Map<string, { at: number; skills: string[]; also: string[] }>();
  const kept: KitBlock[] = [];
  for (const block of blocks) {
    const requirement = role.requirements.find((entry) => entry.id === block.gap?.requirementId);
    const line = block.gap && requirement ? madeLine(requirement, block.gap, profile) : null;
    const template = profile.gapTemplates.find((entry) => entry.id === block.gap?.templateId);
    if (
      !block.gap ||
      !requirement ||
      line?.made !== "template" ||
      !listable(template?.text ?? "")
    ) {
      kept.push(block);
      continue;
    }
    // The related fact tells lines apart only where the template names it.
    const related = template!.text.includes("{related}") ? block.gap.relatedFactId : "";
    const key = JSON.stringify([block.gap.templateId, related]);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { at: kept.length, skills: [line.skill], also: [] });
      kept.push(block);
      continue;
    }
    if (!group.skills.includes(line.skill)) group.skills.push(line.skill);
    const first = kept[group.at]!.gap!.requirementId;
    if (requirement.id !== first && !group.also.includes(requirement.id)) {
      group.also.push(requirement.id);
    }
    if (block.paragraphBreak && kept.length > 0) {
      kept[kept.length - 1] = { ...kept.at(-1)!, paragraphBreak: true };
    }
  }
  for (const group of groups.values()) {
    const first = kept[group.at]!;
    const template = profile.gapTemplates.find((entry) => entry.id === first.gap!.templateId)!;
    const related = profile.facts.find((fact) => fact.id === first.gap!.relatedFactId);
    kept[group.at] = {
      ...first,
      text: filled(template.text, group.skills, related),
      ...(group.also.length > 0 ? { alsoAnswers: group.also } : {}),
    };
  }
  return kept;
}

/** The model's blocks as the kit keeps them: IDs by position, and every gap line written by code. */
function blocksOf(answer: DraftAnswer, role: Role, profile: ProfileParts): KitBlock[] {
  return answer.blocks.map((block, i) => {
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
}

function fitOf(answer: DraftAnswer): FitRow[] {
  return answer.fit.map((row) => ({
    requirementId: row.requirement_id,
    verdict: row.verdict,
    factIds: row.fact_ids,
    note: row.note,
  }));
}
