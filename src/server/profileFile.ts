import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type ValidatedProfile, validateProfile } from "@/core/profile/validate";

/**
 * Reads a profile file from disk and checks it, with its CV and style
 * examples named relative to the file (profile spec, "Seeding"). Used by
 * the seed script and by the end-to-end tests' sample. The schema keeps
 * every named file in the profile's folder or below it; a folder or
 * anything else that is not a regular file counts as no file.
 */
export function loadProfileFile(file: string): ValidatedProfile {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch {
    return {
      ok: false,
      problems: [{ line: 1, message: "the file is not UTF-8 text; save it as UTF-8" }],
    };
  }
  const folder = dirname(file);
  return validateProfile(text, {
    read: (path) => {
      const full = resolve(folder, path);
      return statSync(full, { throwIfNoEntry: false })?.isFile()
        ? new Uint8Array(readFileSync(full))
        : null;
    },
  });
}
