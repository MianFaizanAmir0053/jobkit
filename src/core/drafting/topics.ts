import type { FixedAnswers } from "@/core/profile/schema";
import { isCountryCode, placeCode, placeContains, placeName } from "@/core/shared/regions";
import { skillTag } from "@/core/shared/skills";

/**
 * Screening questions with fixed answers (drafting spec, "Screening
 * questions: fixed answers first"). Two classifiers label each question
 * with a topic: this module's keyword table, and the drafter. When both
 * name the same topic, code answers from the profile; when only one does,
 * or they differ, the owner chooses on the review page between the
 * profile's answer and a drafted one; a question addressed to AI is never
 * answered. A topic that needs a currency, a place or a skill the question
 * does not give, or the profile does not hold, needs the owner's answer.
 * The model never writes the answer to a topic question.
 */

export const TOPICS = [
  "salary",
  "notice_period",
  "availability",
  "time_zone",
  "relocation",
  "work_authorisation",
  "sponsorship",
  "years_with_skill",
  "eeo",
] as const;

export type Topic = (typeof TOPICS)[number];

/**
 * The keyword table: each topic's words, whole and without case, tried in
 * this order, so a question about authorisation "without sponsorship" is a
 * sponsorship question. It reads words, not meaning: "Visa payments" trips
 * it, and the drafter, the other classifier, does not.
 */
const KEYWORDS: readonly (readonly [Topic, RegExp])[] = [
  ["eeo", /\b(?:gender|race|racial|ethnicity|ethnic|veteran|disabilit(?:y|ies)|disabled)\b/i],
  ["sponsorship", /\b(?:sponsor(?:ship|ed)?|visas?|h-?1b)\b/i],
  [
    "work_authorisation",
    /\b(?:authori[sz](?:ed|ation) to work|right to work|work permit|(?:legally )?(?:eligible|allowed|entitled) to work|citizen(?:ship)?|permanent resident|green card)\b/i,
  ],
  [
    "salary",
    /\b(?:salary|salaries|compensation|ctc|lpa|remuneration|pay (?:expectations?|range)|expected pay|desired pay|per annum|hourly rate|rate expectations?)\b/i,
  ],
  ["notice_period", /\bnotice(?: period)?\b/i],
  [
    "availability",
    /\b(?:start date|when can you (?:start|join)|available to (?:start|join)|availability|earliest (?:start|joining)|joining date)\b/i,
  ],
  ["time_zone", /\b(?:time ?zones?|working hours|overlap)\b/i],
  ["relocation", /\b(?:relocat(?:e|ion|ing)|willing to move|open to moving)\b/i],
  [
    "years_with_skill",
    /\b(?:how many years|years of (?:\w+ )?experience|years(?:'|’)? experience|years have you)\b/i,
  ],
];

/** The keyword table's topic for a question, or null. */
export function keywordTopic(question: string): Topic | null {
  for (const [topic, words] of KEYWORDS) if (words.test(question)) return topic;
  return null;
}

export type TopicDecision =
  /** No topic: an ordinary question, which the drafter answers. */
  | { kind: "ordinary" }
  /** Addressed to AI: never answered, whatever either classifier says. */
  | { kind: "not_answered" }
  /** Both classifiers agree: code answers from the profile. */
  | { kind: "fixed"; topic: Topic }
  /** One classifier, or two that differ: the owner chooses the profile's answer or a drafted one. */
  | { kind: "choice"; topic: Topic };

/** What happens to a screening question, given the drafter's topic for it. */
export function decideTopic(
  question: { text: string; addressed_to_ai: boolean },
  drafterTopic: Topic | null,
): TopicDecision {
  if (question.addressed_to_ai) return { kind: "not_answered" };
  const keyword = keywordTopic(question.text);
  if (keyword && keyword === drafterTopic) return { kind: "fixed", topic: keyword };
  const named = keyword ?? drafterTopic;
  return named ? { kind: "choice", topic: named } : { kind: "ordinary" };
}

export type FixedAnswer =
  | { kind: "answer"; text: string }
  /** "Needs your answer": the topic's parameter is missing, or the profile does not hold it. */
  | { kind: "needs_your_answer"; reason: string };

/** What the fixed answers draw on: the owner's home country, and the profile's fixed answers. */
export interface TopicProfile {
  home: string;
  answers: FixedAnswers;
}

const needs = (reason: string): FixedAnswer => ({ kind: "needs_your_answer", reason });
const answer = (text: string): FixedAnswer => ({ kind: "answer", text });

/** Words as written, for finding a place, a skill or a currency. */
function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
}

/** A short place counts only in capitals: "UK" and "UAE", never "in" (India) or a sentence's "Do". */
const SHORT_PLACE = /^[\p{Lu}\d]+$/u;
/** A short skill counts only with a capital, as "Go" or "R" are written. */
const SHORT_SKILL = /^\p{Lu}/u;

/**
 * Every name in the text the lookup knows, each once, in order: at each
 * place it tries three words, then two, then one, and goes on after the
 * longest name found; a word of three letters or fewer counts alone only
 * when `short` takes it.
 */
function allKnown(text: string, lookup: (name: string) => string | null, short: RegExp): string[] {
  const words = wordsOf(text).map((word) => word.replace(/[.-]+$/, ""));
  const found: string[] = [];
  for (let start = 0; start < words.length;) {
    let step = 1;
    for (let size = 3; size >= 1; size--) {
      const parts = words.slice(start, start + size);
      if (parts.length < size) continue;
      if (size === 1 && parts[0]!.length <= 3 && !short.test(parts[0]!)) continue;
      const known = lookup(parts.join(" "));
      if (known) {
        if (!found.includes(known)) found.push(known);
        step = size;
        break;
      }
    }
    start += step;
  }
  return found;
}

/**
 * The one name in the text the lookup knows; null for none, and "several"
 * for a question about more than one, which one answer from the profile
 * cannot give.
 */
function oneKnown(
  text: string,
  lookup: (name: string) => string | null,
  short: RegExp,
): string | null | "several" {
  const found = allKnown(text, lookup, short);
  return found.length > 1 ? "several" : (found[0] ?? null);
}

/** Currencies as a question may name them: a code, or a symbol. */
const CURRENCY_CODES = new Set([
  "USD",
  "EUR",
  "GBP",
  "AED",
  "PKR",
  "INR",
  "SAR",
  "QAR",
  "CAD",
  "AUD",
]);
const CURRENCY_SIGNS: Readonly<Record<string, string>> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
  "₨": "PKR",
};

/** Dollars written with a country's letters before the sign: "A$" is Australian, never US. */
const PREFIXED_DOLLARS: Readonly<Record<string, string>> = {
  US: "USD",
  A: "AUD",
  AU: "AUD",
  C: "CAD",
  CA: "CAD",
  NZ: "NZD",
  S: "SGD",
  SG: "SGD",
  HK: "HKD",
};

function currencyOf(question: string): string | null {
  for (const word of wordsOf(question)) {
    const code = word.toUpperCase();
    if (CURRENCY_CODES.has(code)) return code;
  }
  const prefixed = /\b([A-Z]{1,2})\$/.exec(question)?.[1];
  if (prefixed && PREFIXED_DOLLARS[prefixed]) return PREFIXED_DOLLARS[prefixed];
  for (const [sign, code] of Object.entries(CURRENCY_SIGNS)) {
    if (question.includes(sign)) return code;
  }
  return null;
}

/** Pay the owner has now, which the profile does not hold: it holds what they expect. */
const CURRENT_PAY = /\b(?:current|present|existing|last drawn|now earning|earn now)\b/i;

/** A place's name as a sentence says it: "the United Kingdom", "Pakistan". */
function inWords(code: string): string {
  const name = placeName(code);
  return !isCountryCode(code) ||
    /^United\b|\b(?:Kingdom|Republic|Union|Emirates|Netherlands|Philippines|Bahamas|Gambia|Maldives)\b/.test(
      name,
    )
    ? `the ${name}`
    : name;
}

/**
 * Where the owner stands on working in a place, as a statement, never a bare
 * Yes or No, which a question worded the other way ("…without
 * sponsorship?") would turn false: the profile's own words for the place
 * when it gives them; null where it does not say whether sponsorship is
 * needed and the question is about sponsorship.
 */
function standing(
  topic: "work_authorisation" | "sponsorship",
  place: string,
  entry: FixedAnswers["work_authorisation"][number] | undefined,
): string | null {
  if (entry?.text) return entry.text;
  const where = inWords(place);
  if (!entry || entry.authorised)
    return `Authorised to work in ${where}, with no sponsorship needed.`;
  if (entry.sponsorship_needed === true) {
    return `Not authorised to work in ${where}; would need sponsorship.`;
  }
  if (entry.sponsorship_needed === false) {
    return `Not authorised to work in ${where}; would not need sponsorship.`;
  }
  return topic === "work_authorisation" ? `Not authorised to work in ${where}.` : null;
}

/** The profile's entry for a place: the place itself, or a listed region that takes it in. */
function authorisationFor(place: string, answers: FixedAnswers) {
  return answers.work_authorisation.find(
    (entry) => entry.place === place || placeContains(entry.place, place) === true,
  );
}

const EEO_PARTS: readonly (readonly [RegExp, keyof FixedAnswers["eeo"]])[] = [
  [/\bgender\b/i, "gender"],
  [/\b(?:race|racial|ethnicity|ethnic)\b/i, "ethnicity"],
  [/\bveteran\b/i, "veteran"],
  [/\b(?:disabilit(?:y|ies)|disabled)\b/i, "disability"],
];

/** The profile's answer to a topic question, or why the owner must give one. */
export function fixedAnswer(topic: Topic, question: string, profile: TopicProfile): FixedAnswer {
  const { answers, home } = profile;
  switch (topic) {
    case "salary": {
      if (CURRENT_PAY.test(question)) {
        return needs("The profile holds the salary you expect, not your current one.");
      }
      const currency = currencyOf(question);
      if (!currency) return needs("The question names no currency.");
      const text = answers.salary_expectation[currency];
      return text ? answer(text) : needs(`The profile holds no salary in ${currency}.`);
    }
    case "notice_period":
      return answer(answers.notice_period);
    case "availability":
      return answer(answers.availability);
    case "time_zone":
      return answer(answers.working_window.text);
    case "relocation": {
      // A place the profile does not list: whether the owner would move there is theirs to say.
      const place = oneKnown(question, placeCode, SHORT_PLACE);
      if (place === "several") return needs("The question names more than one place.");
      const listed =
        place === null ||
        !answers.relocation.open ||
        answers.relocation.places.some((each) => placeContains(each, place) === true);
      return listed
        ? answer(answers.relocation.text)
        : needs("The profile does not say whether you would relocate there.");
    }
    case "work_authorisation":
    case "sponsorship": {
      const place = oneKnown(question, placeCode, SHORT_PLACE);
      if (place === "several") return needs("The question names more than one country.");
      if (!place) return needs("The question names no country.");
      const entry = authorisationFor(place, answers);
      // Home needs no entry: the owner may work there, with no sponsor.
      if (!entry && place !== home) return needs("The profile does not answer for this country.");
      const stated = standing(topic, place, entry);
      return stated === null
        ? needs("The profile does not say whether sponsorship is needed there.")
        : answer(stated);
    }
    case "years_with_skill": {
      const skill = oneKnown(question, skillTag, SHORT_SKILL);
      if (skill === "several") return needs("The question names more than one skill.");
      if (!skill) return needs("The question names no skill.");
      const years = answers.years_per_stack[skill];
      if (years === undefined) return needs("The profile holds no years for this skill.");
      return answer(years === 1 ? "1 year" : `${years} years`);
    }
    case "eeo": {
      const part = EEO_PARTS.find(([words]) => words.test(question))?.[1];
      return part ? answer(answers.eeo[part]) : needs("The question is about no listed topic.");
    }
  }
}
