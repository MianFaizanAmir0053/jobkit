import type { FixedAnswers } from "@/core/profile/schema";
import { placeCode, placeContains, placeName, WORLDWIDE } from "@/core/shared/regions";
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

const WORD = /[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu;

/** Words as written, for finding a currency. */
function wordsOf(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** Whether a word at this place begins a sentence, or follows a colon: "Rest assured", "React: …". */
function sentenceStart(text: string, at: number): boolean {
  const before = text.slice(0, at).replace(/[\s"'“”‘’([]+$/u, "");
  return before === "" || /[.?!:]$/.test(before);
}

/**
 * A word that counts as a place's name alone: a short one only in capitals,
 * "UK" and "UAE", never "in" (India) or a sentence's "Do".
 */
const placeWord = (word: string) => word.length > 3 || /^[\p{Lu}\d]+$/u.test(word);

/**
 * A word that counts as a skill's name alone: written as a name is, with a
 * capital ("React", "Go") or a name's mark ("node.js", "C#"), and not where
 * any word takes a capital, at a sentence's start: many skills' names are
 * words too ("your next role", "Three or more", "Rest assured").
 */
const skillWord = (word: string, starts: boolean) =>
  !starts && (/^\p{Lu}/u.test(word) || /[.+#]/.test(word));

/**
 * Words before a place that make it another place: "New South Wales" is not
 * Wales, nor "South America" America, nor "New Mexico" Mexico.
 */
const PLACE_QUALIFIERS: ReadonlySet<string> = new Set([
  "new",
  "north",
  "south",
  "east",
  "west",
  "central",
  "latin",
  "northern",
  "southern",
  "eastern",
  "western",
  "greater",
  "upper",
  "lower",
]);

/**
 * Every name in the text the lookup knows, each once, in order: at each
 * place it tries three words, then two, then one, and goes on after the
 * longest name found; a name of one word counts only where `counts` takes
 * it. A name a capitalised qualifier makes another (`qualifiers`) is none
 * the lookup knows: the text then names one jobkit cannot read.
 */
function namesIn(
  text: string,
  lookup: (name: string) => string | null,
  counts: (word: string, starts: boolean) => boolean,
  qualifiers: ReadonlySet<string> = new Set(),
): { found: string[]; unread: boolean } {
  const words = [...text.matchAll(WORD)].map((match) => ({
    word: match[0].replace(/[.-]+$/, ""),
    starts: sentenceStart(text, match.index),
  }));
  const found: string[] = [];
  let unread = false;
  for (let start = 0; start < words.length;) {
    let step = 1;
    for (let size = 3; size >= 1; size--) {
      const parts = words.slice(start, start + size);
      if (parts.length < size) continue;
      if (size === 1 && !counts(parts[0]!.word, parts[0]!.starts)) continue;
      const known = lookup(parts.map((part) => part.word).join(" "));
      if (known) {
        // A qualifier in the sentence before ("…in the North. Pakistan…") makes no other place.
        const before = parts[0]!.starts ? "" : (words[start - 1]?.word ?? "");
        if (/^\p{Lu}/u.test(before) && qualifiers.has(before.toLowerCase())) unread = true;
        else if (!found.includes(known)) found.push(known);
        step = size;
        break;
      }
    }
    start += step;
  }
  return { found, unread };
}

/**
 * The one place the question names; null for none, "several" for a question
 * about more than one, which one answer from the profile cannot give, and
 * "unread" for a place jobkit cannot read.
 */
function onePlace(question: string): string | null | "several" | "unread" {
  const { found, unread } = namesIn(question, placeCode, placeWord, PLACE_QUALIFIERS);
  if (unread) return "unread";
  return found.length > 1 ? "several" : (found[0] ?? null);
}

/** The one skill the question names, as `onePlace` reads a place. */
function oneSkill(question: string): string | null | "several" {
  const { found } = namesIn(question, skillTag, skillWord);
  return found.length > 1 ? "several" : (found[0] ?? null);
}

/** Currency codes a question may write in any case. */
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

/** Codes a question names only in capitals, as some are words too ("TRY" is lira, "try" a word). */
const CAPITAL_CODES = new Set([
  "SGD",
  "NZD",
  "HKD",
  "KWD",
  "BHD",
  "OMR",
  "JPY",
  "CNY",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "TRY",
  "ILS",
  "EGP",
  "ZAR",
  "NGN",
  "KES",
  "BDT",
  "LKR",
  "NPR",
  "MYR",
  "IDR",
  "THB",
  "BRL",
  "MXN",
  "TWD",
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
  R: "BRL",
  MX: "MXN",
  NT: "TWD",
};

/** The currency a question names; "unread" for dollars of a kind jobkit does not know ("AR$"). */
function currencyOf(question: string): string | null | "unread" {
  for (const word of wordsOf(question)) {
    if (CURRENCY_CODES.has(word.toUpperCase())) return word.toUpperCase();
    if (CAPITAL_CODES.has(word)) return word;
  }
  const prefixed = /\b([A-Z]{1,3})\$/.exec(question)?.[1];
  if (prefixed) return PREFIXED_DOLLARS[prefixed] ?? "unread";
  for (const [sign, code] of Object.entries(CURRENCY_SIGNS)) {
    if (question.includes(sign)) return code;
  }
  return null;
}

/** Pay the owner has had or has now, which the profile does not hold: it holds what they expect. */
const PAST_PAY =
  /\b(?:current(?:ly)?|present|existing|last|previous|prior|past|former|drawn|now earning|earning now|earn now)\b/i;

/** The period pay is counted by, in a question or the profile's words. */
const PERIODS: readonly (readonly [string, RegExp])[] = [
  ["hour", /\b(?:hourly|per hour|an hour)\b|\/\s?(?:hr|hour)\b/i],
  ["day", /\b(?:daily|per day|a day)\b/i],
  ["week", /\b(?:weekly|per week|a week)\b/i],
  ["month", /\b(?:monthly|per month|a month)\b|\/\s?(?:mo|month)\b/i],
  ["year", /\b(?:annual(?:ly)?|yearly|per annum|per year|a year|lpa)\b|\/\s?(?:yr|year)\b/i],
];

function periodOf(text: string): string | null {
  return PERIODS.find(([, words]) => words.test(text))?.[0] ?? null;
}

/**
 * A place's name as a sentence says it: "the United Kingdom", "the Cayman
 * Islands", "the Middle East", "Pakistan", "North America".
 */
function inWords(code: string): string {
  if (code === WORLDWIDE) return "any country";
  const name = placeName(code);
  return /^(?:United|European|Gulf|Middle East)\b|\b(?:Kingdom|Republic|Union|Emirates|Islands|Netherlands|Philippines|Bahamas|Gambia|Maldives)\b/.test(
    name,
  )
    ? `the ${name}`
    : name;
}

/**
 * Where the owner stands on working in a place, as a statement, never a bare
 * Yes or No, which a question worded the other way ("…without
 * sponsorship?") would turn false: the profile's own words for the place
 * when it gives them, but for words that open with a Yes or a No, which
 * answer one question and not its opposite; null where it does not say
 * whether sponsorship is needed and the question is about sponsorship.
 */
function standing(
  topic: "work_authorisation" | "sponsorship",
  place: string,
  entry: FixedAnswers["work_authorisation"][number] | undefined,
): string | null {
  if (entry?.text && !/^\s*(?:yes|no|y|n|true|false)\b/i.test(entry.text)) return entry.text;
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

/** The profile's entry for a place: the place's own, else a listed region that takes it in. */
function authorisationFor(place: string, answers: FixedAnswers) {
  const entries = answers.work_authorisation;
  return (
    entries.find((entry) => entry.place === place) ??
    entries.find((entry) => placeContains(entry.place, place) === true)
  );
}

/** Years of something besides the skill itself: leading, managing or teaching with it. */
const OTHER_YEARS =
  /\b(?:lead|leads|leading|led|leader(?:ship)?|manag(?:e|es|ed|ing|ement|er)|teach(?:es|ing)?|taught|mentor(?:s|ed|ing)?|supervis(?:e|ed|ing|or)|architect(?:ed|ing)?)\b/i;

/** Availability for a call, not a start date. */
const TO_TALK = /\b(?:interviews?|calls?|meetings?|chats?)\b/i;

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
      if (PAST_PAY.test(question)) {
        return needs("The profile holds the salary you expect, not one you have had.");
      }
      const currency = currencyOf(question);
      if (currency === "unread") return needs("The question names a currency jobkit cannot read.");
      if (!currency) return needs("The question names no currency.");
      const text = answers.salary_expectation[currency];
      if (!text) return needs(`The profile holds no salary in ${currency}.`);
      // An hourly rate is not a month's pay: the profile's words say which period they count.
      const asked = periodOf(question);
      return asked && periodOf(text) !== asked
        ? needs("The question asks for pay by another period than your profile gives.")
        : answer(text);
    }
    case "notice_period":
      return answer(answers.notice_period);
    case "availability":
      return TO_TALK.test(question)
        ? needs("The question asks when you are free to talk, not when you can start.")
        : answer(answers.availability);
    case "time_zone":
      return answer(answers.working_window.text);
    case "relocation": {
      // A place the profile does not list: whether the owner would move there is theirs to say.
      const place = onePlace(question);
      if (place === "unread") return needs("The question names a place jobkit cannot read.");
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
      const place = onePlace(question);
      if (place === "unread") return needs("The question names a place jobkit cannot read.");
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
      if (OTHER_YEARS.test(question)) {
        return needs("The question asks for years of something besides the skill.");
      }
      const skill = oneSkill(question);
      if (skill === "several") return needs("The question names more than one skill.");
      if (!skill) return needs("The question names no skill.");
      const years = answers.years_per_stack[skill];
      if (years === undefined) return needs("The profile holds no years for this skill.");
      return answer(years === 1 ? "1 year" : `${years} years`);
    }
    case "eeo": {
      const parts = new Set(
        EEO_PARTS.filter(([words]) => words.test(question)).map(([, part]) => part),
      );
      if (parts.size > 1) return needs("The question asks about more than one thing.");
      const [part] = parts;
      return part ? answer(answers.eeo[part]) : needs("The question is about no listed topic.");
    }
  }
}
