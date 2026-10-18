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
 * "Open application link" for a form kit: the post's link, as the URL parser
 * reads it, only when it is https and names no user or password (which can
 * make a link read as another site's). Any other link is shown as text with a
 * warning, never opened.
 */
export function applicationLink(address: string): string | null {
  const trimmed = address.trim();
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url.href;
}
