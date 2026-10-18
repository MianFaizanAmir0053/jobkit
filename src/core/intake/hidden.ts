/**
 * What a post's text never needs (intake spec, "Inputs", item 3): NUL,
 * which Postgres text cannot hold, the tag characters, which show nothing
 * yet spell words a model reads, and the overrides, embeddings and isolates
 * that turn text around on screen. The server drops them from what it keeps
 * and the New job page from a share it shows, so the owner sees what the
 * model reads. The direction marks and the joiners stay: written Urdu and
 * emoji use them.
 */

const code = (point: number) => String.fromCodePoint(point);

const HIDDEN = new RegExp(
  `[${code(0)}${code(0xe0000)}-${code(0xe007f)}${code(0x202a)}-${code(0x202e)}${code(0x2066)}-${code(0x2069)}]`,
  "gu",
);

export function withoutHidden(text: string): string {
  return text.replace(HIDDEN, "");
}
