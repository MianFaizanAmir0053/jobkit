import { skillTag } from "@/core/shared/skills";
import { sha256Hex } from "@/lib/encoding";

/**
 * Keys that let the ledger recognise the same company, role, address or post
 * however each is written (ledger spec, "Normalisation and keys").
 */

/** Legal-form words dropped from the end of a company name. */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  ...["ltd", "limited", "llc", "llp", "inc", "incorporated", "corp", "corporation", "co"],
  ...["company", "pvt", "private", "gmbh", "ag", "bv", "nv", "sa", "srl", "plc", "pte", "pty"],
  ...["fz", "fze", "fzco", "smc"],
  // The Gulf: W.L.L., DMCC, PJSC, S.P.C., K.S.C.C., Q.P.S.C., B.S.C. and Est.
  ...["wll", "dmcc", "pjsc", "psc", "spc", "ksc", "kscc", "qpsc", "qsc", "bsc", "est"],
  // Europe and Asia: "GmbH & Co. KG", L.P., S.L., AB, Oy, SE, S.p.A., SARL, SAS, Sdn Bhd.
  ...["kg", "lp", "sl", "ab", "oy", "se", "spa", "sarl", "sas", "sdn", "bhd"],
]);

/** Abbreviations in role titles and requirements, expanded before comparing. */
const ABBREVIATIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["sr", ["senior"]],
  ["snr", ["senior"]],
  ["jr", ["junior"]],
  ["jnr", ["junior"]],
  ["eng", ["engineer"]],
  ["engr", ["engineer"]],
  ["dev", ["developer"]],
  ["swe", ["software", "engineer"]],
  ["fe", ["front", "end"]],
  ["be", ["back", "end"]],
]);

/** Work-mode words that say where, not what; "on site" is matched as a pair. */
const WORK_MODES: ReadonlySet<string> = new Set(["remote", "hybrid", "onsite"]);

/**
 * Words a title's brackets or set-apart parts may add to the role: its
 * seniority, level or grade, which make another role, and its discipline.
 * A part made of these, or naming a skill, is kept; brackets otherwise hold
 * places, work modes and labels such as "(Urgent hiring)", which a repost
 * changes freely.
 */
const MODIFIER_WORDS: ReadonlySet<string> = new Set([
  ...["senior", "junior", "lead", "principal", "staff", "head", "team", "tech"],
  ...["mid", "level", "entry", "intern", "internship", "trainee", "associate", "grade", "bps"],
  ...["frontend", "front", "backend", "back", "end", "fullstack", "full", "stack"],
  ...["mobile", "android", "ios", "web", "devops", "qa", "data", "ml", "ai"],
]);

/** A level written as a number or a Roman numeral, or such as "L3": "(II)", "(Level 2)", "(BPS-17)". */
const LEVEL = /^(?:[ivx]{1,4}|l?\d{1,2})$/;

/** Words that name a role, by which a title's main part is told from a place or label set apart from it. */
const ROLE_NOUNS: ReadonlySet<string> = new Set([
  ...["developer", "engineer", "designer", "manager", "analyst", "architect", "lead", "specialist"],
  ...["consultant", "intern", "internship", "administrator", "admin", "scientist", "officer"],
  ...[
    "executive",
    "writer",
    "tester",
    "programmer",
    "coordinator",
    "associate",
    "head",
    "director",
  ],
  ...["technician", "trainee", "representative", "assistant", "strategist", "marketer"],
  ...["accountant", "researcher", "editor", "recruiter", "teacher", "tutor"],
]);

/**
 * Lower-case words, split at anything that is not a letter or digit. Dots
 * are dropped first, so "Sr." is "sr", "B.V." is "bv" and "React.js" is
 * "reactjs"; an abbreviation's dot written against the next word, as in
 * "Sr.React", parts them.
 */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\b(sr|snr|jr|jnr|eng|engr)\.(?=\p{L})/gu, "$1 ")
    .replaceAll(".", "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** Words with their abbreviations expanded. */
function expanded(words: readonly string[]): string[] {
  return words.flatMap((word) => ABBREVIATIONS.get(word) ?? [word]);
}

/** A part kept beside the role: every word a modifier or a level, or the whole part a skill such as "Java". */
function isModifier(part: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  return (
    words.every((word) => MODIFIER_WORDS.has(word) || LEVEL.test(word)) || skillTag(part) !== null
  );
}

/** A bracket's parts kept beside the role, such as "Senior" in "(Senior, Lahore)". */
function bracketModifiers(text: string): string[] {
  return text.split(/[,/|;–—]|\s-\s/).flatMap((part) => {
    const words = expanded(wordsOf(part));
    return isModifier(part, words) ? words : [];
  });
}

/**
 * A role title's words, in one order: the seniority, level, discipline or
 * skill its brackets or set-apart parts add, then the part that names the
 * role. So "React Developer (Senior)", "React Developer - Senior" and
 * "Senior React Developer" are one role, and "(Lahore)", "- Lahore",
 * "| Remote" or "Urgent hiring:" go. A title none of whose parts names a
 * role keeps all of them. Work-mode words go everywhere.
 */
function titleWords(title: string): string[] {
  const modifiers: string[] = [];
  // [^()] keeps the match linear, however many brackets are left open.
  const unbracketed = title.replace(
    /\(([^()]*)\)|\[([^[\]]*)\]/g,
    (_bracket, round: string | undefined, square: string | undefined) => {
      modifiers.push(...bracketModifiers(round ?? square ?? ""));
      return " ";
    },
  );
  const parts = unbracketed
    .split(/\s+[-–—|]\s+|:\s+|,\s+/)
    .map((part) => ({ part, words: expanded(wordsOf(part)) }))
    .filter(({ words }) => words.length > 0);
  const naming = parts.filter(({ words }) => words.some((word) => ROLE_NOUNS.has(word)));
  const main: string[] = [];
  for (const { part, words } of parts) {
    if (naming.length === 0 || naming.some((named) => named.words === words)) main.push(...words);
    else if (isModifier(part, words)) modifiers.push(...words);
  }
  return withoutWorkModes([...modifiers, ...main]);
}

function withoutWorkModes(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (WORK_MODES.has(words[i]!)) continue;
    if (words[i] === "on" && words[i + 1] === "site") {
      i++;
      continue;
    }
    kept.push(words[i]!);
  }
  return kept;
}

/**
 * The company without case, legal forms, bracketed text or punctuation;
 * none for an empty name. "M/s" opens a name only with its slash, so "M&S"
 * keeps its letters.
 */
export function companyKey(company: string): string | null {
  const text = company.normalize("NFC").replace(/\([^()]*\)|\[[^[\]]*\]/g, " ");
  let words = wordsOf(text);
  if (/^\s*m\/s\b/i.test(text)) words = words.slice(2);
  else if (words[0] === "messrs") words = words.slice(1);
  while (words.length > 0 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.length > 0 ? words.join("") : null;
}

/** The role without case, places, labels, work modes or punctuation, so "Front-End" is "Frontend". */
export function roleKey(role: string): string {
  return titleWords(role).join("");
}

/** SHA-256 of the company key, a bar and the role key; none without a company. */
export function companyRoleHash(company: string, role: string): string | null {
  const key = companyKey(company);
  return key === null ? null : sha256Hex(`${key}|${roleKey(role)}`);
}

/**
 * Calling codes after which an international number may repeat its trunk
 * 0, as in "+92 0300 1234567". Italy keeps that 0 in every form, so it is
 * not listed. Calling codes are prefix-free, so at most one fits.
 */
const CALLING_CODES: ReadonlySet<string> = new Set([
  ...["1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "40", "41", "43", "44", "45"],
  ...["46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62"],
  ...["63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"],
  ...["212", "213", "216", "218", "234", "254", "351", "352", "353", "354", "356", "357", "358"],
  ...["359", "370", "371", "372", "380", "381", "385", "386", "420", "421", "880", "960", "961"],
  ...["962", "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975"],
  "977",
]);

/** No phone number, with its labels, is longer; a longer address is compared as written. */
const MAX_NUMBER_TEXT = 60;

/** A decimal digit of any script as its value, so Urdu "۰۳۰۰" is "0300". */
function asciiDigit(digit: string): string {
  const point = digit.codePointAt(0)!;
  let start = point;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1)) && point - start < 9) start--;
  return String((point - start) % 10);
}

/**
 * An email address without case, surrounding spaces or a mailto: prefix; a
 * phone number as its digits, in one form: without a tel: or wa.me/ prefix
 * or a label ("WhatsApp:", "(WhatsApp)"), invisible marks, leading zeros
 * (the trunk 0, and the 00 of "0092…"), or a trunk 0 repeated after the
 * country code ("+92 (0)300…", "+92 0300…"), and with digits of any script.
 * So "+92 300 123-4567" is "923001234567" and "0300-1234567" is
 * "3001234567". Anything else is kept as written.
 */
export function addressKey(address: string): string | null {
  const text = address
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Nd}/gu, asciiDigit)
    .trim()
    .toLowerCase();
  if (text === "") return null;
  const email = text.replace(/^mailto:/, "");
  if (email.includes("@")) return email;
  if (text.length > MAX_NUMBER_TEXT) return text;
  const number = text
    .replace(/^(?:tel:|(?:https?:\/\/)?wa\.me\/|[\p{L} ]{1,20}:)/u, "")
    .replace(/\(([^()]*)\)/g, (bracket, inner: string) => (/\p{L}/u.test(inner) ? " " : bracket))
    .replace(/[‐-―−]/g, "-")
    .replaceAll("(0)", "")
    .trim();
  if (!/^[+\d\s().-]+$/.test(number)) return text;
  let digits = number.replace(/\D/g, "").replace(/^0+/, "");
  if (number.startsWith("+") || number.startsWith("00") || digits.length >= 12) {
    for (const length of [1, 2, 3]) {
      const code = digits.slice(0, length);
      if (!CALLING_CODES.has(code)) continue;
      if (digits[length] === "0") digits = code + digits.slice(length + 1);
      break;
    }
  }
  return digits || null;
}

/** The fewest digits of a number written without its country code. */
const MIN_NATIONAL_DIGITS = 8;

/**
 * Whether two addresses are the same email address or phone number. A
 * number may be written with its country code or without it, so one key
 * may end with the other: "+92 300 1234567" and "0300-1234567" are one
 * number, as are "+971 50 123 4567" and "050 123 4567".
 */
export function sameAddress(a: string, b: string): boolean {
  const x = addressKey(a);
  const y = addressKey(b);
  if (x === null || y === null) return false;
  if (x === y) return true;
  if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return false;
  const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
  return shorter.length >= MIN_NATIONAL_DIGITS && longer.endsWith(shorter);
}

/**
 * A post's fingerprint: the word trigrams of its requirement texts, after
 * the same lower-casing and abbreviations, plus each line of one or two
 * words whole, since a terse list ("PHP", "Laravel") names its stack there.
 */
export function postFingerprint(requirements: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const requirement of requirements) {
    const words = expanded(wordsOf(requirement));
    if (words.length > 0 && words.length < 3) tokens.add(words.join(" "));
    for (let i = 0; i + 2 < words.length; i++) {
      tokens.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }
  return tokens;
}

/** The Jaccard index of two fingerprints; zero when either is empty. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}
