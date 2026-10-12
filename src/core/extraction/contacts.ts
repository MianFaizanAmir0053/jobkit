import { parse } from "tldts";

/**
 * The strict contact checks (extraction spec, "Strict contact checks"). An
 * address or number read from a post ends up in a mailto: or wa.me link, and
 * the post is untrusted, so each passes only in a narrow form: a post cannot
 * smuggle a second recipient or a header into the link, even percent-encoded,
 * and a message never goes to a country jobkit guessed. Anything else is
 * flagged, and the owner types the contact on the review page.
 */

/** The flag for a number in any form but the few whose country is certain. */
export const NUMBER_FLAG = "Check this number's country code";

export type NumberResult = { ok: true; number: string } | { ok: false; reason: typeof NUMBER_FLAG };

/** ASCII letters, digits and ". _ + -" only: no quoting, encoding, separators or query marks. */
const LOCAL_PART = /^[A-Za-z0-9._+-]+$/;

/** A host label: letters, digits and hyphens, with no hyphen at either end. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Whether an email address passes: a local part of ASCII letters, digits,
 * ".", "_", "+" and "-" with no leading, trailing or doubled dot; one "@";
 * and a domain of such labels with a registrable name under a public suffix
 * (tldts), so "hr@acme" and "hr@co.uk" fail. Lengths stay within RFC 5321's.
 * Nothing is trimmed: a space anywhere fails.
 */
export function isStrictAddress(address: string): boolean {
  const parts = address.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (domain.length > 253) return false;
  if (!domain.split(".").every((label) => label.length <= 63 && LABEL.test(label))) return false;
  const host = parse(domain.toLowerCase());
  return host.isIcann === true && host.domain !== null;
}

/** Full lengths, country code included, where the code's length is known. */
const NUMBER_LENGTHS: ReadonlyMap<string, number> = new Map([
  ["92", 12],
  ["44", 12],
  ["971", 12],
  ["966", 12],
  ["1", 11],
]);

/**
 * A WhatsApp number as its digits with the country code, or the flag. After
 * dropping a trunk 0 written as "(0)" right after the country code, and then
 * spaces, dashes, dots and brackets, only these forms pass: "+" or "00" and an
 * international number; "92" and ten digits; "03" and nine digits, a Pakistani
 * mobile, which gains its 92. The result must have its country's length.
 */
export function normaliseWhatsAppNumber(text: string): NumberResult {
  const compact = text.replace(/^(\+|00)(\d{1,3})[\s.-]*\(0\)/, "$1$2").replace(/[\s.()-]/g, "");
  let digits: string;
  if (/^\+\d+$/.test(compact)) digits = compact.slice(1);
  else if (/^00\d+$/.test(compact)) digits = compact.slice(2);
  else if (/^92\d{10}$/.test(compact)) digits = compact;
  else if (/^03\d{9}$/.test(compact)) digits = `92${compact.slice(1)}`;
  else return { ok: false, reason: NUMBER_FLAG };
  return fullLength(digits) ? { ok: true, number: digits } : { ok: false, reason: NUMBER_FLAG };
}

/**
 * Twelve digits after 92, 44, 971 and 966, eleven after 1, and 8 to 15 after
 * any other code (E.164's range). Calling codes are prefix-free, so at most
 * one listed code fits; none starts with 0.
 */
function fullLength(digits: string): boolean {
  if (digits.startsWith("0")) return false;
  for (const codeLength of [3, 2, 1]) {
    const expected = NUMBER_LENGTHS.get(digits.slice(0, codeLength));
    if (expected !== undefined) return digits.length === expected;
  }
  return digits.length >= 8 && digits.length <= 15;
}
