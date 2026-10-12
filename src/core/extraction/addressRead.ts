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
 * What the second look gave: the other model's read of the crop (null when
 * it saw none, or the call failed), whether pasted text holds the contact,
 * or why no crop could be read.
 */
export type SecondRead =
  { read: string | null } | { inText: boolean } | { problem: "invalid_box" | "no_crop" };

export type AgreementProblem =
  "disagree" | "no_second_read" | "invalid_box" | "no_crop" | "not_in_text";

export type Agreement = { ok: true } | { ok: false; reason: AgreementProblem };

export function agreement(kind: ContactKind, contact: string, second: SecondRead): Agreement {
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

/** What may sit inside an address: next to one, these make a longer address. */
const ADDRESS_CHAR = /[A-Za-z0-9._%+-]/;
const ALPHANUMERIC = /[A-Za-z0-9]/;

const DASHES = String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212);
/** A run of digits, possibly with "+", brackets, spaces, dots and dashes: a number as a post writes it. */
const NUMBER_RUN = new RegExp(`\\+?[\\d(][\\d\\s().\\-${DASHES}]{5,}\\d`, "g");

/** Whether pasted text holds the contact: an address verbatim and whole, a number by its digits. */
export function inPastedText(kind: ContactKind, contact: string, text: string): boolean {
  const wanted = contact.trim();
  if (wanted === "") return false;
  if (kind === "email") return holdsWhole(text, wanted);
  const number = normaliseWhatsAppNumber(wanted);
  if (!number.ok) return false;
  return [...text.matchAll(NUMBER_RUN)].some(([run]) => {
    const found = normaliseWhatsAppNumber(run);
    return found.ok && found.number === number.number;
  });
}

/** Whether `address` stands in `text` as a whole address: "jobs@x.com" is not in "xjobs@x.com.uk". */
function holdsWhole(text: string, address: string): boolean {
  for (let at = text.indexOf(address); at >= 0; at = text.indexOf(address, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text[at + address.length] ?? "";
    const next = text[at + address.length + 1] ?? "";
    // A full stop ends a sentence unless a letter or digit follows it.
    const continues = after === "." ? ALPHANUMERIC.test(next) : ADDRESS_CHAR.test(after);
    if (!ADDRESS_CHAR.test(before) && !continues) return true;
  }
  return false;
}
