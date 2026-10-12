import { type JobRecord, MAX_QUOTE_LENGTH, type SCAM_KINDS } from "./record";

/**
 * The phrase backstop (extraction spec, "Stage extract"). Code scans the
 * pasted text, and the record's quoted fields (instructions, the route's
 * quote, the eligibility quotes and other limits), for numbers in Pakistani
 * CNIC format, IBANs whose checksum holds, and the phrases "registration
 * fee", "processing fee", "CNIC", "passport copy" and "bank account". When
 * the model reported no scam signal, each kind it finds becomes one, quoting
 * the line it was found on, so a request the model missed still reaches the
 * review page.
 */

type ScamKind = (typeof SCAM_KINDS)[number];

export interface ScamSignal {
  kind: ScamKind;
  quote: string;
}

interface Pattern {
  kind: ScamKind;
  /** Where in the line the first real hit starts, or -1. */
  find(line: string): number;
}

const first =
  (pattern: RegExp) =>
  (line: string): number =>
    line.search(pattern);

const PATTERNS: readonly Pattern[] = [
  { kind: "national_id", find: first(/\b\d{5}-\d{7}-\d\b/) },
  { kind: "national_id", find: first(/\bcnics?\b/i) },
  { kind: "national_id", find: first(/\bpassport cop(?:y|ies)\b/i) },
  { kind: "bank_details", find: first(/\bbank accounts?\b/i) },
  { kind: "bank_details", find: firstIban },
  { kind: "fee", find: first(/\b(?:registration|processing) fees?\b/i) },
];

// A country code, two check digits, then groups of four, as IBANs are written, with or without spaces.
const IBAN_SHAPE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi;

// Characters a quote may show either side of a hit, when its line is too long to show whole.
const BEFORE_HIT = 40;

export function backstopSignals(record: JobRecord, pastedText: string): ScamSignal[] {
  if (record.scam_signals.length > 0) return [];
  const found = new Map<ScamKind, string>();
  for (const text of [pastedText, ...quotedFields(record)]) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      for (const { kind, find } of PATTERNS) {
        if (found.has(kind)) continue;
        const at = find(line);
        if (at >= 0) found.set(kind, quoteAround(line, at));
      }
    }
  }
  return [...found].map(([kind, quote]) => ({ kind, quote }));
}

function quotedFields(record: JobRecord): string[] {
  return record.roles.flatMap((role) => [
    ...role.instructions.flatMap((instruction) => [instruction.text, instruction.value]),
    role.route.quote,
    ...role.eligibility.work_authorisation.map((entry) => entry.quote),
    ...role.eligibility.other_limits,
  ]);
}

function firstIban(line: string): number {
  for (const match of line.matchAll(IBAN_SHAPE)) {
    if (isIban(match[0])) return match.index;
  }
  return -1;
}

/** Whether the text is an IBAN: 15 to 34 characters whose mod-97 checksum is 1 (ISO 13616). */
function isIban(text: string): boolean {
  const iban = text.replace(/ /g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** The line, or a window of it around the hit when it is too long, never splitting a character. */
function quoteAround(line: string, at: number): string {
  if (line.length <= MAX_QUOTE_LENGTH) return line;
  let start = Math.max(0, Math.min(at - BEFORE_HIT, line.length - MAX_QUOTE_LENGTH));
  let end = start + MAX_QUOTE_LENGTH;
  if (isLowSurrogate(line.charCodeAt(start))) start += 1;
  if (isHighSurrogate(line.charCodeAt(end - 1))) end -= 1;
  return line.slice(start, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
