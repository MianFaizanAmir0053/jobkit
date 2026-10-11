import { z } from "zod";

/**
 * An enum field for a stage's answer that takes its values in any letter
 * case. Claude's structured outputs hold the model to an enum's values but
 * not to their case, and the docs advise comparing them without case
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs#invalid-outputs).
 *
 * A string that matches exactly one value when ASCII letters are compared
 * without case becomes that value; anything else is left for the enum to
 * refuse. Its JSON Schema is the enum's, so the API still constrains the
 * model to the values. zod refuses a discriminated union whose discriminator
 * is caseless, throwing on every parse, so a field that chooses between
 * branches makes them a plain union, whose values must not differ only in case.
 */
export function caseless<const T extends readonly [string, ...string[]]>(values: T) {
  const unique = [...new Set(values)];
  return z
    .string()
    .transform((text) => spelled(text, unique))
    .pipe(z.enum(values));
}

function spelled(text: string, values: readonly string[]): string {
  if (values.includes(text)) return text;
  const folded = foldAscii(text);
  const matches = values.filter((value) => foldAscii(value) === folded);
  return matches.length === 1 ? matches[0]! : text;
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
