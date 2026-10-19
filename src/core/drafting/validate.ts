import type { JobRecord, Role } from "@/core/extraction/record";

import { knownLineFits, NEEDS_YOUR_LINE, oneLine, type ProfileParts } from "./build";
import { checkFit } from "./fit";
import {
  answersOf,
  bodyWords,
  type FitRow,
  type Kit,
  type KitBlock,
  MESSAGE_LIMIT,
  messageLength,
} from "./kit";

/**
 * The code checks on an email or a message kit (drafting spec,
 * "validate(kit, context)"): citations, the fit check, gap lines, the
 * email's word limit or the message's 600 characters, the accepted keyword,
 * anything an AI-addressed line asked for, internal IDs or markers in the
 * text, a line only the owner can write, sensitive topics in drafted
 * sentences and the email's subject and greeting, a placeholder left in the
 * subject, and a body that says nothing about the owner. Pure: it only
 * flags, never rewrites, so it runs again after each edit. A form's answers
 * have their own flags, and its cover note the email body's. An email's flags read as they
 * always have, since a flag's name holds its message (flagKey).
 */

export type KitFlagKind =
  | "invalid_citation"
  | "fit_unverified"
  | "fit_missing"
  | "missing_gap_line"
  | "over_limit"
  | "keyword_missing"
  | "ai_instruction_followed"
  | "reference_leak"
  | "needs_your_line"
  | "sensitive_topic_drafted"
  | "subject_placeholder"
  | "no_claims"
  | "needs_your_answer"
  | "topic_choice_needed"
  | "fixed_answer_drafted"
  | "short_answer_unconfirmed";

export interface KitFlag {
  kind: KitFlagKind;
  /** A block's ID, a requirement's ID, or "body", "subject", "greeting" or "kit". */
  at: string;
  message: string;
}

export interface KitContext {
  record: JobRecord;
  role: Role;
  profile: ProfileParts;
  fit: readonly FitRow[];
  wordLimit: number;
  keyword: string | null;
  /** The post's subject format code applied, or null for the default subject. */
  subjectFormat: string | null;
  /** The marker strings the drafting call used. */
  markers: readonly string[];
}

/** What a requirement only the owner can confirm says on the page. */
export const ONLY_YOU_CAN_CONFIRM = "Only you can confirm you meet this requirement.";

const MESSAGES = {
  invalid_citation:
    "This sentence cites something that is not in your approved profile or the post. Check it, or cut it.",
  fit_facts:
    "Marked as met, but no cited fact shows every skill named at the depth and for the years asked.",
  fit_tick: ONLY_YOU_CAN_CONFIRM,
  fit_missing: "The draft did not weigh this requirement.",
  missing_gap_line: "A must-have you do not fully meet has no honest line about it.",
  needs_your_line: "Write this line yourself: no gap line in your profile fits this requirement.",
  sensitive_topic_drafted:
    "This mentions money, visas, work permits or another personal topic only your profile may answer. Check it.",
  subject_placeholder:
    "The subject still holds a placeholder from the post. Fill it in before you send.",
  no_claims: "The email says nothing about you yet. Write at least one sentence from your profile.",
  topic_choice_needed:
    "jobkit's two checks did not agree that your profile answers this: use your profile's answer, or a drafted one.",
  fixed_answer_drafted:
    "The draft answered this itself; jobkit put your profile's answer in its place. Check it.",
  short_answer_unconfirmed:
    "A short answer: tick it once you have checked it says only what is true.",
  answer_citation:
    "This answer cites something that is not in your approved profile. Check it, or write your own.",
} as const;

/** The fewest words a drafted answer has before it needs no tick (drafting spec, "validate"). */
const SHORT_ANSWER = 6;

// Money: a currency next to a number; a number with a currency word, or in lakhs or crores; a
// large amount, or one in thousands, millions or lakhs, per month or year, unless a count follows
// ("50k/month active users"); and pay itself, in words that mean nothing else here. Visas,
// sponsorship and the right to work. Equal-opportunity topics worded about a person. Names that
// share a word are not topics: Passport.js and Laravel Passport, Visa payments, a "Citizen
// Portal", RS256, CTC loss, lag compensation, take-home assignments, race conditions.
const SENSITIVE = [
  /(?:\b(?:usd|pkr|eur|gbp|aed|sar|qar|kwd|omr|bhd|sgd|cad|aud|inr)\.?\s?|\brs(?:\.\s?|\s)|[$£€₨₹]\s?)\d/i,
  /\d[\d,.]*\s?(?:usd|pkr|eur|gbp|aed|sar|qar|kwd|omr|bhd|sgd|cad|aud|inr|dollars?|rupees?|pounds?|euros?|riyals?|dirhams?|lacs?|lakhs?|crores?)\b/i,
  /(?:\b\d{1,3}(?:,\d{3})+|\b\d{4,}|\b\d+(?:\.\d+)?\s?(?:k|m|lacs?|lakhs?))\s?(?:(?:\/\s?|per |an? )(?:month|mo|year|yr|annum)\b|monthly\b|annually\b|yearly\b|p\.?[ma]\.?(?![a-z]))(?!\s+(?:active\s+)?(?:users?|visitors?|requests?|orders?|transactions?|events?|messages?|sessions?|downloads?|installs?|customers?|calls?|records?|rows?|queries|views?|signups?|subscribers?|hits?)\b)/i,
  /\b(?:salary|salaries|remuneration|stipend|lpa|per annum|take-home pay|pay (?:range|expectations?|package))\b/i,
  /\b(?:(?:my|current|expected|annual|monthly|total|base)\s+(?:compensation|ctc|take-home)|(?:compensation|ctc)\s+(?:expectations?|package|range|of|is))\b/i,
  /\b(?:visas?(?!\s*(?:payments?|cards?|checkout|api|direct|network|integration|\/|&|,\s*mastercard|and\s+mastercard))|sponsor(?:ship|ed|s|ing)?|work (?:authori[sz]ation|permits?)|right to work|(?:authori[sz]ed|eligible|permitted) to work|citizen(?:s|ship)?(?!\s+portal)|nationality|(?<!laravel\s)passports?(?!\.js\b|-[a-z])|permanent residen(?:t|cy|ce))\b/i,
  /\b(?:gender|ethnicity|veteran status|military service|(?:my|a|have a) disabilit(?:y|ies)|I am disabled|(?:my|your|of any|regardless of) race|race(?:,| or| and)\s+(?:ethnicity|religion|colou?r|gender|national origin)|(?:ethnicity|religion|colou?r|gender|national origin)(?:,| or| and)\s+race)\b/i,
];

// What a post's subject format can leave once {name} and {role} are filled: a short span in
// paired brackets holding a stand-in word ("[Your Name]", "(Job Title)"), "%ROLE%", or "Your
// Name". A bracket with no stand-in word ("[REF-2291]") is the post's own text.
const STAND_IN = "your|name|role|position|title|job|first|last|full|candidate|applicant|surname";
const PLACEHOLDERS = new RegExp(
  [
    `\\[[^\\]]{0,40}\\b(?:${STAND_IN})\\b[^\\]]{0,40}\\]`,
    `\\{[^}]{0,40}\\b(?:${STAND_IN})\\b[^}]{0,40}\\}`,
    `<[^>]{0,40}\\b(?:${STAND_IN})\\b[^>]{0,40}>`,
    `\\([^)]{0,40}\\b(?:${STAND_IN})\\b[^)]{0,40}\\)`,
    "%[a-z_]{2,20}%",
    "\\byour (?:full )?name\\b",
  ].join("|"),
  "gi",
);

/** A letter or a digit: a sentence holding none says nothing. */
const WORDY = /[\p{L}\p{N}]/u;

/**
 * Whether drafted text raises a topic only the profile may answer. The
 * post's own names, the company's and the role's, are taken out first: a
 * role at Visa is no visa.
 */
function isSensitive(text: string, names: readonly string[]): boolean {
  const rest = names.reduce((left, name) => without(left, name), text);
  return SENSITIVE.some((pattern) => pattern.test(rest));
}

/** `text` with every occurrence of `name`, in any case, replaced by a space. */
function without(text: string, name: string): string {
  const target = name.trim().toLowerCase();
  if (target === "") return text;
  const lower = text.toLowerCase();
  // Lower-casing can change a string's length; then nothing is taken out.
  if (lower.length !== text.length) return text;
  let rest = "";
  let from = 0;
  for (let at = lower.indexOf(target); at >= 0; at = lower.indexOf(target, from)) {
    rest += `${text.slice(from, at)} `;
    from = at + target.length;
  }
  return rest + text.slice(from);
}

export function validateKit(kit: Kit, context: KitContext): KitFlag[] {
  const flags: KitFlag[] = [];
  // Each finding once: two lines aimed at AI that read alike as the message quotes them are one,
  // and its name (flagKey) is one flag's.
  const flag = (kind: KitFlagKind, at: string, message: string) => {
    if (flags.some((each) => each.kind === kind && each.at === at && each.message === message)) {
      return;
    }
    flags.push({ kind, at, message });
  };
  const { role, profile } = context;
  const factIds = new Set(profile.facts.map((fact) => fact.id));
  const names = [context.record.company.name, role.title];
  const noun = kit.kind;
  // What the kit's own words are: an email's or a message's body, a form's cover note and answers.
  const answers = kit.kind === "form" ? kit.answers : [];

  if (kit.kind === "email") {
    if (leftPlaceholder(kit.subject, context.subjectFormat)) {
      flag("subject_placeholder", "subject", MESSAGES.subject_placeholder);
    }
    if (isSensitive(kit.subject, names))
      flag("sensitive_topic_drafted", "subject", MESSAGES.sensitive_topic_drafted);
    if (isSensitive(kit.greeting, names)) {
      flag("sensitive_topic_drafted", "greeting", MESSAGES.sensitive_topic_drafted);
    }
  }
  for (const block of kit.blocks) {
    // A gap whose line code could not write (no known line, no template) is the owner's: it
    // needs their line, and once they type one it cites nothing.
    const ownersLine =
      block.class === "gap" &&
      block.gap !== null &&
      block.gap.knownLineId === "" &&
      block.gap.templateId === "" &&
      role.requirements.some((requirement) => requirement.id === block.gap?.requirementId);
    if (ownersLine) {
      if (block.text === NEEDS_YOUR_LINE) {
        flag("needs_your_line", block.id, MESSAGES.needs_your_line);
      }
    } else if (!block.owner && !citesTruly(block, context, factIds)) {
      // The owner's own words cite nothing: their confirmation stands for them.
      flag("invalid_citation", block.id, MESSAGES.invalid_citation);
    }
    // A personal topic is the owner's to raise in their own words; a drafter's is checked.
    if (block.class !== "gap" && !block.owner && isSensitive(block.text, names)) {
      flag("sensitive_topic_drafted", block.id, MESSAGES.sensitive_topic_drafted);
    }
  }
  // Each answer by how it came: the owner's words are theirs; a drafted one is a claim, however
  // short, which cites its facts and raises no personal topic.
  for (const answer of answers) {
    if (answer.owner) continue;
    if (answer.source === "needs_your_answer") {
      flag("needs_your_answer", answer.id, `Needs your answer. ${answer.reason ?? ""}`.trim());
    } else if (answer.source === "choice") {
      flag("topic_choice_needed", answer.id, MESSAGES.topic_choice_needed);
    } else if (answer.source === "profile" && answer.replaced) {
      flag("fixed_answer_drafted", answer.id, MESSAGES.fixed_answer_drafted);
    } else if (answer.source === "drafted") {
      if (answer.factIds.length === 0 || !answer.factIds.every((id) => factIds.has(id))) {
        flag("invalid_citation", answer.id, MESSAGES.answer_citation);
      }
      if (isSensitive(answer.text, names)) {
        flag("sensitive_topic_drafted", answer.id, MESSAGES.sensitive_topic_drafted);
      }
      if (answer.text.split(/\s+/).filter((word) => word !== "").length < SHORT_ANSWER) {
        flag("short_answer_unconfirmed", answer.id, MESSAGES.short_answer_unconfirmed);
      }
    }
  }
  if (!kit.blocks.some((block) => block.class === "claim" && WORDY.test(block.text))) {
    flag(
      "no_claims",
      "body",
      kit.kind === "email"
        ? MESSAGES.no_claims
        : kit.kind === "message"
          ? "The message says nothing about you yet. Write at least one sentence from your profile."
          : "The cover note says nothing about you yet. Write at least one sentence from your profile.",
    );
  }

  const { flags: fitFlags, verdicts } = checkFit(role, context.fit, profile.facts);
  for (const fitFlag of fitFlags) {
    if (fitFlag.kind === "fit_missing") {
      flag("fit_missing", fitFlag.requirementId, MESSAGES.fit_missing);
    } else {
      const message = fitFlag.reason === "needs_tick" ? MESSAGES.fit_tick : MESSAGES.fit_facts;
      flag("fit_unverified", fitFlag.requirementId, message);
    }
  }
  for (const requirement of role.requirements) {
    if (requirement.priority !== "must" || verdicts.get(requirement.id) === "met") continue;
    const answered = kit.blocks.some((block) => answersOf(block).includes(requirement.id));
    if (!answered) flag("missing_gap_line", requirement.id, MESSAGES.missing_gap_line);
  }

  // An email's body and a form's cover note count their words against the limit in force; a
  // message counts its characters, the sign-off included, against 600, and no word limit applies.
  if (kit.kind !== "message") {
    const words = bodyWords(kit);
    if (words > context.wordLimit) {
      flag(
        "over_limit",
        "body",
        kit.kind === "email"
          ? `The email's body is ${words} words; the limit is ${context.wordLimit}.`
          : `The cover note is ${words} words; the limit is ${context.wordLimit}.`,
      );
    }
  } else if (messageLength(kit) > MESSAGE_LIMIT) {
    flag(
      "over_limit",
      "body",
      `The message is ${messageLength(kit)} characters with your sign-off; the limit is ${MESSAGE_LIMIT}.`,
    );
  }

  // The keyword counts only in the body, as a word of its own: "Go" is not in "good". A form's
  // answers are its words too.
  const body = [...kit.blocks, ...answers].map((each) => each.text).join("\n");
  if (context.keyword !== null && !hasWord(body, context.keyword)) {
    flag(
      "keyword_missing",
      "body",
      `The post asks you to include a keyword, and the ${noun} does not.`,
    );
  }
  // From every role: a line aimed at AI that the model recorded under another role still counts.
  // Looked for in the body only: the subject, greeting, closing and sign-off are the app's words.
  // Each value once, however many roles record its line and in whatever case, as it is matched,
  // so taking one out never hides another.
  const followed = new Map<string, string>();
  for (const value of context.record.roles
    .flatMap((each) => each.instructions)
    .filter((instruction) => instruction.addressed_to_ai)
    .map((instruction) => oneLine(instruction.value))) {
    // A value under three characters ("OK") is matched in its own case, so "ok" in a sentence is not it.
    const exact = [...value].length < 3;
    if (!isCheckable(value) || !hasWord(body, value, exact)) continue;
    const key = exact ? value : value.toLowerCase();
    if (!followed.has(key)) followed.set(key, value);
  }
  for (const value of followed.values()) {
    const shown = [...value].slice(0, 60).join("");
    flag(
      "ai_instruction_followed",
      "kit",
      `The ${noun} repeats “${shown}”, which a line aimed at AI tools asked for. Take it out.`,
    );
  }

  const references = [
    ...profile.facts.map((fact) => fact.id),
    ...profile.knownGaps.map((gap) => gap.id),
    ...profile.gapTemplates.map((template) => template.id),
    ...context.markers,
  ].filter((reference) => reference !== "");
  const sentences = kit.blocks.map((block) => block.text);
  const texts =
    kit.kind === "email"
      ? [kit.subject, kit.greeting, ...sentences, kit.closing]
      : kit.kind === "message"
        ? [...sentences, kit.signOff]
        : [...sentences, ...answers.map((answer) => answer.text)];
  // Each leak named, so a check on one never covers another: a profile ID as it is, a marker by
  // its start.
  const leaked = references.filter((reference) => texts.some((text) => hasToken(text, reference)));
  if (leaked.length > 0) {
    const named = [
      ...new Set(
        leaked.map((reference) =>
          context.markers.includes(reference) ? `a marker (${reference.slice(0, 6)}…)` : reference,
        ),
      ),
    ];
    flag(
      "reference_leak",
      "kit",
      `An internal ID or marker appears in the ${noun}: ${named.join(", ")}. Take it out.`,
    );
  }
  return flags;
}

/** Whether a block's references are real: facts of this profile, fields of this post, a gap line's sources. */
function citesTruly(block: KitBlock, context: KitContext, factIds: ReadonlySet<string>): boolean {
  const { role, record, profile } = context;
  if (block.class === "claim") {
    return block.factIds.length > 0 && block.factIds.every((id) => factIds.has(id));
  }
  if (block.class === "post") {
    if (block.fields.length === 0) return false;
    return block.fields.every((field) => {
      if (field === "company.name") {
        return record.company.name !== "" && block.text.includes(record.company.name);
      }
      if (field === "title") return role.title !== "" && block.text.includes(role.title);
      return role.requirements.some((requirement) => requirement.id === field);
    });
  }
  if (block.class === "gap") {
    const gap = block.gap;
    const requirement = role.requirements.find((entry) => entry.id === gap?.requirementId);
    if (!gap || !requirement) return false;
    // A known line answers a requirement only by naming one of its skills.
    const knownLine = profile.knownGaps.find((entry) => entry.id === gap.knownLineId);
    const known =
      gap.knownLineId === "" || (knownLine !== undefined && knownLineFits(knownLine, requirement));
    const template =
      gap.templateId === "" || profile.gapTemplates.some((entry) => entry.id === gap.templateId);
    const related = gap.relatedFactId === "" || factIds.has(gap.relatedFactId);
    // A merged line answers only requirements the post has.
    const also = (block.alsoAnswers ?? []).every((id) =>
      role.requirements.some((entry) => entry.id === id),
    );
    return (
      known && template && related && also && (gap.knownLineId !== "" || gap.templateId !== "")
    );
  }
  return true;
}

/** Whether `token` stands alone in `text`, not inside a longer word: "S3" never matches "F-S3". */
export function hasToken(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + token.length] ?? "";
    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) return true;
    from = at + 1;
  }
}

/** A letter, a digit or a mark: what words are made of, in any script. A hyphen is not. */
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;

/** The character before index `i`, a whole surrogate pair when it is one. */
function charBefore(text: string, i: number): string {
  if (i <= 0) return "";
  const low = text.charCodeAt(i - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  return String.fromCodePoint(text.codePointAt(start)!);
}

function charAt(text: string, i: number): string {
  return i < text.length ? String.fromCodePoint(text.codePointAt(i)!) : "";
}

/**
 * Whether `word` stands alone in `text`, not inside a longer run of letters
 * or digits in any script: "Java" is not in "JavaScript", nor "sum" in
 * "résumé", but "pineapple" is in "pineapple-themed". In any case, unless
 * `matchCase`. IDs and markers use hasToken instead, where a hyphen joins.
 */
export function hasWord(text: string, word: string, matchCase = false): boolean {
  const haystack = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? word : word.toLowerCase();
  if (needle === "") return false;
  const startsWord = WORD_CHAR.test(charAt(needle, 0));
  const endsWord = WORD_CHAR.test(charBefore(needle, needle.length));
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const clearBefore = !startsWord || !WORD_CHAR.test(charBefore(haystack, at));
    const clearAfter = !endsWord || !WORD_CHAR.test(charAt(haystack, at + needle.length));
    if (clearBefore && clearAfter) return true;
  }
  return false;
}

/**
 * Whether a value a line aimed at AI asked for can be looked for: two
 * characters or more, or a single one that is not a letter or a digit,
 * such as an emoji. A lone letter would be found everywhere.
 */
export function isCheckable(value: string): boolean {
  const chars = [...value];
  return chars.length >= 2 || (chars.length === 1 && !WORDY.test(value));
}

/**
 * Whether a placeholder the post's subject format left, once {name} and
 * {role} were filled, is still in the subject. Only the format's own words
 * are looked at, so a title such as "Engineer [Remote]" is no placeholder.
 */
function leftPlaceholder(subject: string, format: string | null): boolean {
  if (format === null) return false;
  const rest = oneLine(format.replaceAll("{name}", " ").replaceAll("{role}", " "));
  return [...rest.matchAll(PLACEHOLDERS)].some(([placeholder]) =>
    subject.toLowerCase().includes(placeholder.toLowerCase()),
  );
}
