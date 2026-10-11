// Postgres text holds no NUL character.
const NUL = String.fromCharCode(0);

/**
 * Text ready for a text column: NUL characters dropped, and cut to `max`
 * UTF-16 units without leaving half of a surrogate pair at the end.
 */
export function storableText(text: string, max = 1000): string {
  const clean = text.split(NUL).join("");
  if (clean.length <= max) return clean;
  const last = clean.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return clean.slice(0, splitsPair ? max - 1 : max);
}

/** A thrown value as storable text, whatever was thrown. */
export function describeThrown(thrown: unknown): string {
  try {
    const text = String(thrown);
    if (typeof text === "string") return storableText(text);
  } catch {
    // An object without a usable toString, such as Object.create(null).
  }
  return "A value that could not be written as text";
}
