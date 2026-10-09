import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type ValidatedProfile, validateProfile } from "@/core/profile/validate";

/**
 * Reads a profile file from disk and checks it, with its CV and style
 * examples named relative to the file (profile spec, "Seeding"). Used by
 * the seed script and by the end-to-end tests' sample.
 */
export function loadProfileFile(file: string): ValidatedProfile {
  const folder = dirname(file);
  return validateProfile(readFileSync(file, "utf8"), {
    read: (path) => {
      const full = resolve(folder, path);
      return existsSync(full) ? new Uint8Array(readFileSync(full)) : null;
    },
  });
}
