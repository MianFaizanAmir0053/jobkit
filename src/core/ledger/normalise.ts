import { placeCode } from "@/core/shared/regions";
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
 * Lower-case words, split at anything that is not a letter or digit. Dots
 * are dropped first, so "Sr." is "sr", "B.V." is "bv" and "React.js" is
 * "reactjs".
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll(".", "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/**
 * Two-letter place codes a title uses for a place. Any other bare pair of
 * letters is read as a word, since "QA", "AI", "IT" and "Sr" are also the
 * codes of Qatar, Anguilla, Italy and Suriname.
 */
const TWO_LETTER_PLACES: ReadonlySet<string> = new Set(["uk", "us", "eu"]);

/** Whether a bracketed part of a title, such as "Lahore" or "Remote / UK", names a place. */
function isPlace(part: string): boolean {
  const letters = part.replace(/[^\p{L}]/gu, "").toLowerCase();
  if (letters.length <= 2 && !TWO_LETTER_PLACES.has(letters)) return false;
  return placeCode(part) !== null;
}

/** A bracket's text without its parts that name a place. */
function withoutPlaces(text: string): string {
  return text
    .split(/[,/|;–—]|\s-\s/)
    .filter((part) => !isPlace(part.trim()))
    .join(" ");
}

/**
 * A role title's words: the bracketed parts that name a place, such as
 * "(Lahore)" or "[Karachi, Pakistan]", dropped; abbreviations expanded;
 * work-mode words dropped. Every other word stays, seniority included, so
 * "Engineer (Senior)" is not "Engineer".
 */
function roleWords(text: string): string[] {
  const unplaced = text.replace(
    /\(([^)]*)\)|\[([^\]]*)\]/g,
    (_bracket, round: string | undefined, square: string | undefined) =>
      ` ${withoutPlaces(round ?? square ?? "")} `,
  );
  const words = wordsOf(unplaced).flatMap((word) => ABBREVIATIONS.get(word) ?? [word]);
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
  const words = wordsOf(company);
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
 * An email address without case or surrounding spaces; a phone number as
 * its digits without leading zeros, so the trunk prefix ("0300…"), the
 * international one ("0092…") and a "(0)" after the country code all go:
 * "+92 300 123-4567" is "923001234567" and "0300-1234567" is "3001234567".
 */
export function addressKey(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  if (trimmed === "") return null;
  if (!trimmed.includes("@") && /^[+\d\s().-]+$/.test(trimmed)) {
    return trimmed.replaceAll("(0)", "").replace(/\D/g, "").replace(/^0+/, "") || null;
  }
  return trimmed;
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
