/**
 * The links a post gives (intake spec, "Inputs"): each web address in the
 * pasted text or the share's url field, kept as a reference and never
 * fetched. An address ends at a space or a character no link holds; a full
 * stop, comma or other sentence mark after it is not part of it, nor is a
 * closing bracket it did not open. Each link is kept once, as written.
 */

/** How many links a job keeps, and how long each may be. */
export const MAX_LINKS = 10;
const MAX_LINK_LENGTH = 2_000;

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"`]+/gi;
const TRAILING = ".,;:!?'\"]}";

const count = (text: string, char: string) => text.split(char).length - 1;

function trimmed(link: string): string {
  let out = link;
  for (;;) {
    const last = out.at(-1);
    if (last !== undefined && TRAILING.includes(last)) out = out.slice(0, -1);
    else if (last === ")" && count(out, "(") < count(out, ")")) out = out.slice(0, -1);
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
