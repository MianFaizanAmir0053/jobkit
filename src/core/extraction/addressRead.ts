import { normaliseWhatsAppNumber } from "./contacts";

/**
 * How a contact's second read settles (extraction spec, "Stage
 * address_read"): two reads of an address agree when equal after trimming
 * and lower-casing, of a number when equal after normalising; a contact
 * from pasted text must appear in the text, an address verbatim and a
 * number by its digits. Anything else, a missing second read, a box that
 * does not fit its screenshot or a crop that could not be made, is a
 * blocking flag: the owner retypes the contact.
 */

export type ContactKind = "email" | "whatsapp";

/**
 * Raise it when the matching here, or what normaliseWhatsAppNumber in
 * contacts.ts accepts (its forms, its lengths), changes, so a pasted-text
 * result kept from before is not reused.
 */
export const MATCHING_VERSION = 3;

/**
 * What the second look gave: the other model's read of the crop (null when
 * it saw none, or the call failed), whether pasted text holds the contact,
 * or why there was no read: no crop could be read, or this machine had no
 * second model.
 */
export type SecondRead =
  | { read: string | null }
  | { inText: boolean }
  | { problem: "invalid_box" | "no_crop" | "no_model" };

export type AgreementProblem =
  | "disagree"
  | "no_second_read"
  | "invalid_box"
  | "no_crop"
  | "no_model"
  | "not_in_text"
  | "bad_number";

export type Agreement = { ok: true } | { ok: false; reason: AgreementProblem };

export function agreement(kind: ContactKind, contact: string, second: SecondRead): Agreement {
  // A number jobkit cannot read with its country code is the owner's to check, whatever the second look gave.
  if (kind === "whatsapp" && !normaliseWhatsAppNumber(contact).ok) {
    return { ok: false, reason: "bad_number" };
  }
  if ("problem" in second) return { ok: false, reason: second.problem };
  if ("inText" in second) {
    return second.inText ? { ok: true } : { ok: false, reason: "not_in_text" };
  }
  if (second.read === null || second.read.trim() === "") {
    return { ok: false, reason: "no_second_read" };
  }
  return sameContact(kind, contact, second.read) ? { ok: true } : { ok: false, reason: "disagree" };
}

function sameContact(kind: ContactKind, one: string, other: string): boolean {
  if (kind === "email") return one.trim().toLowerCase() === other.trim().toLowerCase();
  // A number that does not normalise has no reading two reads could share.
  const first = normaliseWhatsAppNumber(one);
  const second = normaliseWhatsAppNumber(other);
  return first.ok && second.ok && first.number === second.number;
}

/** A letter, digit or mark of any script; a variation selector belongs to the emoji before it. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const VARIATION_SELECTOR = /\p{Variation_Selector}/u;

/**
 * Besides letters and digits, what an address's local part may hold (RFC
 * 5322's atext and the full stop), "@", and the curly apostrophe phones
 * type ("d’souza@acme.com"). None may stand before an address.
 */
const LOCAL_SYMBOLS = new Set([..."!#$%&'*+-/=?^_`{|}~.@", String.fromCodePoint(0x2019)]);

/** What a domain may hold besides letters and digits: none may follow an address. */
const DOMAIN_SYMBOLS = new Set([..."-_@"]);

/** WhatsApp's bold and italic marks: "*hr@acme.com*" is the address, set in bold. */
const MARKS = new Set(["*", "_"]);

const DASHES = String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212);
/**
 * A run of digits, possibly with "+", brackets, spaces, dots and dashes: a
 * number as a post writes it. A run never crosses a line, so numbers listed
 * one to a line, or a figure on the line before, are read apart.
 */
const NUMBER_RUN = new RegExp(`\\+?[\\d(][\\d\\t\\p{Zs}().\\-${DASHES}]{5,}\\d`, "gu");

/** Whether pasted text holds the contact: an address verbatim and whole, a number by its digits. */
export function inPastedText(kind: ContactKind, contact: string, text: string): boolean {
  const wanted = contact.trim();
  if (wanted === "") return false;
  if (kind === "email") return holdsWhole(text, wanted);
  const number = normaliseWhatsAppNumber(wanted);
  if (!number.ok) return false;
  return [...text.matchAll(NUMBER_RUN)].some(([run]) =>
    candidatesOf(run).some((candidate) => {
      const found = normaliseWhatsAppNumber(candidate);
      return found.ok && found.number === number.number;
    }),
  );
}

/**
 * A run as the number, and, when a bracketed note follows the number
 * ("0300-1234567 (9am"), the run before the note. A "(0)" trunk prefix is
 * part of the number. A run is never cut inside its digits, so a shorter
 * number is never found in a longer one.
 */
function candidatesOf(run: string): string[] {
  const note = /\s*\((?!0\))/.exec(run);
  return note && note.index > 0 ? [run, run.slice(0, note.index)] : [run];
}

/** Whether `address` stands in `text` as a whole address: "jobs@x.com" is not in "xjobs@x.com.uk". */
function holdsWhole(text: string, address: string): boolean {
  for (let at = text.indexOf(address); at >= 0; at = text.indexOf(address, at + 1)) {
    if (standsWhole(text, at, at + address.length)) return true;
  }
  return false;
}

/**
 * Whether text[start, end) has nothing on either side that could continue
 * it as an address. Anything else, a space, punctuation, a quote, an emoji
 * or an invisible character, is an edge. In a pair of WhatsApp's marks, the
 * marks' own edges decide.
 */
function standsWhole(text: string, start: number, end: number): boolean {
  const before = charBefore(text, start);
  const after = charAt(text, end);
  if (before !== undefined && MARKS.has(before) && after === before) {
    return standsWhole(text, start - 1, end + 1);
  }
  if (before !== undefined && (isWordChar(before) || LOCAL_SYMBOLS.has(before))) return false;
  if (after === undefined) return true;
  // A full stop ends a sentence unless more of a domain follows it ("acme.com.pk").
  const next = after === "." ? charAt(text, end + 1) : after;
  return next === undefined || !(isWordChar(next) || DOMAIN_SYMBOLS.has(next));
}

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char) && !VARIATION_SELECTOR.test(char);
}

/** The whole character before `index`, a surrogate pair included. */
function charBefore(text: string, index: number): string | undefined {
  return [...text.slice(Math.max(0, index - 2), index)].at(-1);
}

/** The whole character at `index`, a surrogate pair included. */
function charAt(text: string, index: number): string | undefined {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}
