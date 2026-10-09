import { sha256Hex } from "@/lib/encoding";

/**
 * Keys that let the ledger recognise the same company, role, address or post
 * however each is written (ledger spec, "Normalisation and keys").
 */

/** Legal-form words dropped from the end of a company name. */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "ltd",
  "limited",
  "llc",
  "llp",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "pvt",
  "private",
  "gmbh",
  "ag",
  "bv",
  "nv",
  "sa",
  "srl",
  "plc",
  "pte",
  "pty",
  "fz",
  "fze",
  "fzco",
  "smc",
  // The Gulf: W.L.L., DMCC, PJSC, S.P.C., K.S.C.C., Q.P.S.C., B.S.C. and Est.
  "wll",
  "dmcc",
  "pjsc",
  "psc",
  "spc",
  "ksc",
  "kscc",
  "qpsc",
  "qsc",
  "bsc",
  "est",
  // Europe and Asia: "GmbH & Co. KG", L.P., S.L., AB, Oy, SE, S.p.A., SARL, SAS, Sdn Bhd.
  "kg",
  "lp",
  "sl",
  "ab",
  "oy",
  "se",
  "spa",
  "sarl",
  "sas",
  "sdn",
  "bhd",
]);

/** Words that open a company name in Pakistani posts: "M/s Acme", "Messrs Acme". */
const LEGAL_PREFIXES: readonly (readonly string[])[] = [["m", "s"], ["messrs"]];

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
 * Lower-case words, split at anything that is not a letter or digit. Dots
 * are dropped first, so "Sr." is "sr", "B.V." is "bv" and "React.js" is
 * "reactjs"; an abbreviation's dot written against the next word, as in
 * "Sr.React", parts them.
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b(sr|snr|jr|jnr|eng|engr)\.(?=\p{L})/gu, "$1 ")
    .replaceAll(".", "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/**
 * The words a title's brackets may add to the role: its seniority, which
 * makes another role, and its discipline. Brackets otherwise hold places,
 * work modes and labels such as "(Urgent hiring)" or "(Full time)", which
 * a repost changes freely.
 */
const BRACKET_WORDS: ReadonlySet<string> = new Set([
  ...["senior", "sr", "snr", "junior", "jr", "jnr", "lead", "principal", "staff", "head"],
  ...["mid", "level", "entry", "intern", "trainee", "associate"],
  ...["frontend", "front", "backend", "back", "end", "fullstack", "full", "stack"],
  ...["mobile", "android", "ios", "web", "devops", "qa", "data", "ml", "ai"],
]);

/** A bracket's parts made only of seniority and discipline words, such as "Senior" in "(Senior, Lahore)". */
function bracketRole(text: string): string {
  return text
    .split(/[,/|;–—]|\s-\s/)
    .filter((part) => {
      const words = wordsOf(part);
      return words.length > 0 && words.every((word) => BRACKET_WORDS.has(word));
    })
    .join(" ");
}

/**
 * A role title's words: from brackets only seniority and discipline, so
 * "(Lahore)" and "(Urgent hiring)" go while "(Senior)" stays;
 * abbreviations expanded; work-mode words dropped.
 */
function roleWords(text: string): string[] {
  const unbracketed = text.replace(
    /\(([^)]*)\)|\[([^\]]*)\]/g,
    (_bracket, round: string | undefined, square: string | undefined) =>
      ` ${bracketRole(round ?? square ?? "")} `,
  );
  const words = wordsOf(unbracketed).flatMap((word) => ABBREVIATIONS.get(word) ?? [word]);
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

/** The company without case, legal suffixes or punctuation; none for an empty name. */
export function companyKey(company: string): string | null {
  let words = wordsOf(company);
  for (const prefix of LEGAL_PREFIXES) {
    if (prefix.every((word, i) => words[i] === word)) words = words.slice(prefix.length);
  }
  while (words.length > 0 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.length > 0 ? words.join("") : null;
}

/** The role without case, places, work modes or punctuation, so "Front-End" is "Frontend". */
export function roleKey(role: string): string {
  return roleWords(role).join("");
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

/**
 * An email address without case or surrounding spaces; a phone number as
 * its digits, in one form: without a tel: or wa.me/ prefix, a label such
 * as "(WhatsApp)", leading zeros (the trunk 0, and the 00 of "0092…"), or
 * a trunk 0 repeated after the country code, as in "+92 (0)300…" and
 * "+92 0300…". So "+92 300 123-4567" is "923001234567" and "0300-1234567"
 * is "3001234567". Anything else is kept as written.
 */
export function addressKey(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  if (trimmed === "") return null;
  if (trimmed.includes("@")) return trimmed;
  const number = trimmed
    .replace(/^(?:tel:|(?:https?:\/\/)?wa\.me\/)/, "")
    .replace(/\([^)]*\p{L}[^)]*\)/gu, " ")
    .replace(/[‐-―−]/g, "-")
    .replaceAll("(0)", "")
    .trim();
  if (!/^[+\d\s().-]+$/.test(number)) return trimmed;
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

/** The set of word trigrams across a role's requirement texts, after the role normalisation. */
export function postFingerprint(requirements: readonly string[]): Set<string> {
  const trigrams = new Set<string>();
  for (const requirement of requirements) {
    const words = roleWords(requirement);
    for (let i = 0; i + 2 < words.length; i++) {
      trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }
  return trigrams;
}

/** The Jaccard index of two fingerprints; zero when either is empty. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const trigram of a) if (b.has(trigram)) shared++;
  return shared / (a.size + b.size - shared);
}
