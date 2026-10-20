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

/** A word as written, without a closing dot or hyphen, and where it stands in the text. */
interface Word {
  word: string;
  /** Whether it begins a sentence, or follows a colon. */
  starts: boolean;
  index: number;
  end: number;
}

function wordsIn(text: string): Word[] {
  return [...text.matchAll(WORD)].map((match) => {
    const word = match[0].replace(/[.-]+$/, "");
    return {
      word,
      starts: sentenceStart(text, match.index),
      index: match.index,
      end: match.index + word.length,
    };
  });
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
 * Words before a place that make it another place, in any case: "New South
 * Wales" is not Wales, nor "south America" America, nor "New Mexico" Mexico.
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

/** Words after a place that make it another place: "Jersey City", "Panama City", "Jersey Shore". */
const PLACE_NOUNS: ReadonlySet<string> = new Set([
  "city",
  "town",
  "village",
  "county",
  "borough",
  "township",
  "shore",
  "heights",
  "beach",
  "falls",
  "springs",
  "hills",
  "valley",
  "bay",
  "park",
  "harbour",
  "harbor",
]);

/** Words that take a capital without naming anything: "I", and answers such as "Yes/No". */
const COMMON_CAPITALS: ReadonlySet<string> = new Set([
  "i",
  "yes",
  "no",
  "y",
  "n",
  "ok",
  "okay",
  "true",
  "false",
  "ai",
]);

/** A word written as a name is, with a capital, where any word would not take one. */
const nameLike = (each: Word) =>
  !each.starts && /^\p{Lu}/u.test(each.word) && !COMMON_CAPITALS.has(each.word.toLowerCase());

/**
 * Whether a name the table does not know starts at `words[at]` and ends the
 * clause, every word of it written as a name: "Ohio", "New Hampshire", "CA".
 */
function unknownName(
  text: string,
  words: readonly Word[],
  at: number,
  lookup: (name: string) => string | null,
): boolean {
  const name: string[] = [];
  for (let i = at; i < words.length; i++) {
    const each = words[i]!;
    if (!/^\p{Lu}/u.test(each.word)) return false;
    name.push(each.word);
    const next = words[i + 1];
    if (!next || next.starts || /\S/.test(text.slice(each.end, next.index))) break;
  }
  if (name.every((word) => COMMON_CAPITALS.has(word.toLowerCase()))) return false;
  return lookup(name.join(" ")) === null && lookup(name[0]!) === null;
}

/**
 * Whether the place `words[from..to)` names is part of a longer name,
 * which is another place: after a word that makes it one ("New South
 * Wales", "south America", "South-East Asia"), before one ("Jersey City"),
 * or before a comma and a name the table does not know ("Dublin, Ohio",
 * "Dublin, CA"). A word in another sentence, or across a mark, qualifies
 * nothing ("…in the North. Pakistan…").
 */
function partOfLonger(
  text: string,
  words: readonly Word[],
  from: number,
  to: number,
  lookup: (name: string) => string | null,
): boolean {
  const first = words[from]!;
  const before = words[from - 1];
  if (
    before &&
    !first.starts &&
    /^\s+$/.test(text.slice(before.end, first.index)) &&
    before.word
      .toLowerCase()
      .split("-")
      .some((part) => PLACE_QUALIFIERS.has(part))
  ) {
    return true;
  }
  const after = words[to];
  if (!after || after.starts) return false;
  const gap = text.slice(words[to - 1]!.end, after.index);
  if (/^\s+$/.test(gap) && PLACE_NOUNS.has(after.word.toLowerCase())) return true;
  return /^\s*,\s*$/.test(gap) && unknownName(text, words, to, lookup);
}

/**
 * Every name in the text the lookup knows, each once, in order: at each
 * place it tries three words, then two, then one, and goes on after the
 * longest name found; a name of one word counts only where `counts` takes
 * it. The words no name took are the `rest`. With `places`, a name that is
 * part of a longer one is none the lookup knows: the text then names one
 * jobkit cannot read (`unread`).
 */
function namesIn(
  text: string,
  lookup: (name: string) => string | null,
  counts: (word: string, starts: boolean) => boolean,
  places = false,
): { found: string[]; unread: boolean; rest: Word[] } {
  const words = wordsIn(text);
  const found: string[] = [];
  const rest: Word[] = [];
  let unread = false;
  for (let start = 0; start < words.length;) {
    let step = 0;
    for (let size = 3; size >= 1; size--) {
      const parts = words.slice(start, start + size);
      if (parts.length < size) continue;
      if (size === 1 && !counts(parts[0]!.word, parts[0]!.starts)) continue;
      const known = lookup(parts.map((part) => part.word).join(" "));
      if (!known) continue;
      if (places && partOfLonger(text, words, start, start + size, lookup)) unread = true;
      else if (!found.includes(known)) found.push(known);
      step = size;
      break;
    }
    if (step === 0) {
      rest.push(words[start]!);
      step = 1;
    }
    start += step;
  }
  return { found, unread, rest };
}

/**
 * The one place the question names: null for none, "several" for a
 * question about more than one, which one answer from the profile cannot
 * give, and "unread" for a place jobkit cannot read; with the words no
 * place took.
 */
function placesIn(question: string): {
  place: string | null | "several" | "unread";
  rest: Word[];
} {
  const { found, unread, rest } = namesIn(question, placeCode, placeWord, true);
  // In capitals, "US" may be the pronoun ("…REQUIRE US TO SPONSOR…"): only "THE US" or "IN US"
  // names the place.
  const pronoun = !/\p{Ll}/u.test(question) && /(?<!\b(?:THE|IN)\s+)\bUS\b/u.test(question);
  if (unread || pronoun) return { place: "unread", rest };
  return { place: found.length > 1 ? "several" : (found[0] ?? null), rest };
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
  USD: "USD",
  AUD: "AUD",
  CAD: "CAD",
  NZD: "NZD",
  SGD: "SGD",
  HKD: "HKD",
  MEX: "MXN",
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

/** Words after a code that show it is pay's currency: "USD per month", "AED gross". */
const AFTER_CODE =
  /^(?:per|a|an|gross|net|annual(?:ly)?|monthly|yearly|hourly|weekly|daily|equivalent|only|salary|ctc|lpa|pa|k|thousand|million|lakhs?|crores?)$/i;

/**
 * Whether the code at `words[i]` stands where pay's currency does: opening
 * the question, after "in", a bracket, a colon, a comma or a dash, next to
 * an amount, ending a clause, or before a word about pay. "CAD designer"
 * and "SAR imaging" name none.
 */
function currencyPlace(text: string, words: readonly Word[], i: number): boolean {
  const word = words[i]!;
  const before = words[i - 1];
  const after = words[i + 1];
  const amount = (other: Word | undefined) => other !== undefined && /^\d/.test(other.word);
  return (
    before === undefined ||
    /[([:,–—-]/.test(text.slice(before.end, word.index)) ||
    /^in$/i.test(before.word) ||
    amount(before) ||
    after === undefined ||
    /[)\]?.,;:/–—-]/.test(text.slice(word.end, after.index)) ||
    amount(after) ||
    AFTER_CODE.test(after.word)
  );
}

/**
 * The currency a question names, by a code where pay's currency stands, by
 * the letters before a dollar sign ("A$", "Mex$"), or by a sign; "unread"
 * for dollars of a kind jobkit does not know ("AR$").
 */
function currencyOf(question: string): string | null | "unread" {
  const words = wordsIn(question);
  for (const [i, { word }] of words.entries()) {
    const code = CURRENCY_CODES.has(word.toUpperCase())
      ? word.toUpperCase()
      : CAPITAL_CODES.has(word)
        ? word
        : null;
    if (code && currencyPlace(question, words, i)) return code;
  }
  const prefixed = /(\p{L}{1,4})\$/u.exec(question)?.[1];
  if (prefixed) return PREFIXED_DOLLARS[prefixed.toUpperCase()] ?? "unread";
  for (const [sign, code] of Object.entries(CURRENCY_SIGNS)) {
    if (question.includes(sign)) return code;
  }
  return null;
}

/** Pay the owner has had or has now, which the profile does not hold: it holds what they expect. */
const PAST_PAY =
  /\b(?:current(?:ly)?|present|existing|last|previous|prior|past|former|drawn|now earning|earning now|earn now)\b/i;

/**
 * Words that ask for the pay the owner expects, which the profile holds:
 * "expected", "desired", "salary requirements", "rate". A question with none
 * ("What is your salary?") may ask for the pay they have now.
 */
const EXPECTED_PAY =
  /\b(?:expect\w*|ectc|desired?|want(?:ed)?|looking (?:for|to)|seeking|target(?:ed|ing)?|asking|requir(?:e|ed|ement|ements)|hop(?:e|ing) (?:for|to)|like to (?:earn|be paid|make)|rates?)\b/i;

/** The period pay is counted by, in a question or the profile's words. */
const PERIODS: readonly (readonly [string, RegExp])[] = [
  ["hour", /\b(?:hourly|per (?:hour|hr)|an hour|p\/h)\b|\/\s?(?:hr|hour)\b/i],
  ["day", /\b(?:daily|per day|a day|day rate)\b|\/\s?day\b/i],
  ["week", /\b(?:weekly|per (?:week|wk)|a week|p\/w)\b|\/\s?(?:wk|week)\b/i],
  [
    "month",
    /\b(?:monthly|per (?:month|mo|mth|mensem)|a month|p\/m)\b|\/\s?(?:mo|mth|month)\b|(?<![\p{L}\p{N}])p\.m\.?(?![\p{L}\p{N}])/iu,
  ],
  [
    "year",
    /\b(?:annual(?:ly)?|yearly|per (?:annum|year|yr)|a year|lpa|p\/a)\b|\/\s?(?:yr|year|annum)\b|(?<![\p{L}\p{N}])p\.?a\.?(?![\p{L}\p{N}])/iu,
  ],
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

/** Words that answer Yes or No, at the start of the profile's own words, after any quote or mark. */
const OPENS_WITH_ANSWER =
  /^[^\p{L}\p{N}]*(?:yes|yeah|yep|yup|yea|ya|aye|sure|certainly|absolutely|definitely|of course|correct|affirmative|indeed|ok|okay|no|nope|nah|negative|true|false|y|n)(?![\p{L}\p{N}])/iu;

/**
 * Where the owner stands on working in a place, as a statement, never a bare
 * Yes or No, which a question worded the other way ("…without
 * sponsorship?") would turn false: the profile's own words for the place
 * when it gives them, but for words that open with a Yes or a No ("Nope",
 * "“Yes”"), which answer one question and not its opposite; null where it
 * does not say whether sponsorship is needed and the question is about
 * sponsorship.
 */
function standing(
  topic: "work_authorisation" | "sponsorship",
  place: string,
  entry: FixedAnswers["work_authorisation"][number] | undefined,
): string | null {
  if (entry?.text && !OPENS_WITH_ANSWER.test(entry.text)) return entry.text;
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

/**
 * The words a question for years with a skill may hold besides the skill's
 * name, and no others: any other may ask for years of something else
 * ("as a React instructor", "coaching React developers", "senior-level
 * React", "since you last used React"), which the profile does not hold.
 */
const YEARS_WORDS: ReadonlySet<string> = new Set(
  `how many much long what is are the a an total number of in with using use used working worked
  work been have has had do does did you your ve s years year yrs yr experience experiences
  experienced professional professionally commercial commercially hands-on hands on practical
  relevant industry production real-world real world overall direct paid full-time as developer
  engineer programmer dev development developing developed building built coding coded programming
  programmed writing written applications application apps app projects project please enter state
  specify indicate give provide list approximately approx roughly about around required for at so
  far framework library language technology tech stack tool following skill skills expertise
  knowledge frontend front-end backend back-end full-stack fullstack web mobile would say`.split(
    /\s+/,
  ),
);

/**
 * The words a question about when the owner can start may hold, and no
 * others: "availability for a phone screen", "weekly availability in hours"
 * and "availability to travel" ask about something else.
 */
const START_WORDS: ReadonlySet<string> = new Set(
  `what when how soon is are your you can could would will do be able to the a an of s earliest
  soonest possible start starting begin beginning commence commencing join joining onboard
  onboarding date dates availability available from for in with us our team company role position
  job this new if offered offer after receiving accepting hired selected successful please state
  indicate give provide specify enter let know notice period given considering expected expect
  likely potential employment immediately immediate`.split(/\s+/),
);

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
      if (!EXPECTED_PAY.test(question)) {
        return needs(
          "The question does not say it asks for the salary you expect, which the profile holds.",
        );
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
      return wordsIn(question).every((each) => START_WORDS.has(each.word.toLowerCase()))
        ? answer(answers.availability)
        : needs("The question asks about something besides when you can start.");
    case "time_zone":
      return answer(answers.working_window.text);
    case "relocation": {
      const { open, places, text } = answers.relocation;
      // Not open to moving, or open to anywhere: the profile's words hold for any place.
      if (!open || places.includes(WORLDWIDE)) return answer(text);
      // A place the profile does not list: whether the owner would move there is theirs to say.
      const { place, rest } = placesIn(question);
      if (place === "unread") return needs("The question names a place jobkit cannot read.");
      if (place === "several") return needs("The question names more than one place.");
      if (place === null) {
        // A name the table does not know may be a place: "Houston", "our Austin office".
        return rest.some(nameLike)
          ? needs("The question names something jobkit cannot read as a place.")
          : answer(text);
      }
      return places.some((each) => placeContains(each, place) === true)
        ? answer(text)
        : needs("The profile does not say whether you would relocate there.");
    }
    case "work_authorisation":
    case "sponsorship": {
      const { place } = placesIn(question);
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
      const { found, rest } = namesIn(question, skillTag, skillWord);
      if (found.length > 1) return needs("The question names more than one skill.");
      const [skill] = found;
      if (!skill) return needs("The question names no skill.");
      if (rest.some((each) => !YEARS_WORDS.has(each.word.toLowerCase()))) {
        return needs("The question asks for years of something besides the skill.");
      }
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
