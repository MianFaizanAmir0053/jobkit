/**
 * The links a post gives (intake spec, "Inputs"): each web address in the
 * pasted text or the share's url field, kept as a reference and never
 * fetched. An address ends at a space, an invisible character (as LinkedIn
 * copy holds), a mark that sets the text's direction (as Urdu copied from
 * WhatsApp holds), punctuation of Chinese and Japanese, or a character no
 * link holds; a sentence mark or a closing quote after it, Latin or Urdu,
 * is not part of it, nor is a closing bracket it did not open. An address
 * inside an email address or a longer domain is no link. Each link is kept
 * once, as written.
 */

/** How many links a job keeps, and how long each may be. */
export const MAX_LINKS = 10;
const MAX_LINK_LENGTH = 2_000;

const chars = (...codes: number[]) => String.fromCharCode(...codes);
// The zero-width space and joiners, the word joiner, the byte-order mark, and the marks,
// embeddings and isolates that set the text's direction.
const INVISIBLE =
  chars(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x200e, 0x200f, 0x061c) +
  chars(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069);
// The ideographic comma and full stop, and the fullwidth comma, full stop, marks and colons.
const CJK_MARKS = chars(0x3001, 0x3002, 0xff0c, 0xff0e, 0xff01, 0xff1f, 0xff1a, 0xff1b);
// A dot before "https://" ends a sentence, but before "www." it is part of a longer domain.
const LINK = new RegExp(
  `(?:(?<![@\\w])https?:\\/\\/|(?<![@\\w.])www\\.)[^\\s<>"\`${INVISIBLE}${CJK_MARKS}]+`,
  "gi",
);
// Sentence marks and closing quotes: Latin ones, the Urdu comma, semicolon, question mark
// and full stop, the ellipsis, curly quotes and guillemets.
const TRAILING =
  ".,;:!?'\"}*~" + chars(0x060c, 0x061b, 0x061f, 0x06d4, 0x2026, 0x2019, 0x201d, 0x00bb, 0x203a);
const BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[" };

const count = (text: string, char: string) => text.split(char).length - 1;

function trimmed(link: string): string {
  let out = link;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    const opener = BRACKETS[last];
    if (TRAILING.includes(last)) out = out.slice(0, -1);
    else if (opener !== undefined && count(out, opener) < count(out, last)) out = out.slice(0, -1);
    else return out;
  }
}

export function linksIn(...texts: readonly string[]): string[] {
  const links: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(LINK)) {
      const link = trimmed(match[0]);
      if (link.length > MAX_LINK_LENGTH || /^(?:https?:\/\/|www\.)$/i.test(link)) continue;
      if (!links.includes(link)) links.push(link);
    }
  }
  return links.slice(0, MAX_LINKS);
}
