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
 * "Open application link" for a form kit: the post's link as the URL parser
 * reads it, which the page shows and opens alike, only when it is https,
 * names no user or password (which can make a link read as another site's),
 * and opens the host written in it: printable ASCII up to its path, which
 * the parser reads as written but for its case and a default port. A space,
 * a control character, a look-alike slash or dot, a backslash or a percent
 * sign there would open another site. Any other link is shown as text with
 * why (`linkRefusal`), never opened.
 */
export function applicationLink(address: string): string | null {
  return readLink(address).href ?? null;
}

/** Why the page does not open the post's link, as a sentence's start; null for one it opens. */
export function linkRefusal(address: string): string | null {
  return readLink(address).refused ?? null;
}

function readLink(address: string): { href?: string; refused?: string } {
  const trimmed = address.trim();
  if (!URL.canParse(trimmed)) return { refused: "This is not a full https link" };
  const url = new URL(trimmed);
  if (url.protocol !== "https:") return { refused: "This link is not a secure https one" };
  if (url.username !== "" || url.password !== "") {
    return {
      refused: "This link names a user or password, which can make it read as another site's",
    };
  }
  const written = /^https:\/\/([^/?#]*)/i.exec(trimmed)?.[1] ?? "";
  if (!/^[\x21-\x7e]+$/.test(written) || written.toLowerCase().replace(/:443$/, "") !== url.host) {
    return { refused: "This link may open another site than the one it names" };
  }
  return { href: url.href };
}
