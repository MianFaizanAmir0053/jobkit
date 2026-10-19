import { normaliseWhatsAppNumber } from "@/core/extraction/contacts";

/**
 * "Open WhatsApp" for a message kit: WhatsApp's click-to-chat link on the
 * number as normalised (its digits with the country code), with the message
 * encoded whole, so nothing in it can add a parameter. Half of a broken
 * surrogate pair is dropped first, as encodeURIComponent throws on one. No
 * link for a number that does not normalise; the page shows it as text.
 */
export function whatsAppLink(number: string, message: string): string | null {
  const normalised = normaliseWhatsAppNumber(number);
  if (!normalised.ok) return null;
  const text = encodeURIComponent(message.replace(/\p{Cs}/gu, ""));
  return `https://wa.me/${normalised.number}?text=${text}`;
}

/**
 * "Open application link" for a form kit: the post's link, only when it is
 * https, names no user or password (which can make a link read as another
 * site's), and opens exactly the address the page shows: printable ASCII
 * alone, which the URL parser reads as written, but for the case of its
 * scheme and host and a closing slash. A space, a control character, a
 * look-alike slash or dot, or one written with a percent sign would open
 * another site. Any other link is shown as text with a warning, never
 * opened.
 */
export function applicationLink(address: string): string | null {
  const trimmed = address.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmed) || !URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const shown = trimmed.replace(/^https:\/\/[^/?#]*/i, (head) => head.toLowerCase());
  return url.href === shown || url.href === `${shown}/` ? url.href : null;
}
