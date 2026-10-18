import type { DuplicateMatch } from "@/core/ledger/duplicates";
import type { JobState } from "@/core/platform/jobStates";

/** Anything shaped like an email address, its last character a letter or digit. */
const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]*[\p{L}\p{N}]/gu;
/** Eight or more characters of digits and the marks numbers are written with, starting and ending with a digit. */
const NUMBER = /\+?\d[\d\s().-]{6,}\d/g;

/**
 * The post's words with every address, or every number, set aside while
 * the owner must type the contact themselves (review spec, "Contact"):
 * jobkit's reading of it is unconfirmed, so it is never shown to be copied.
 * `kind` is the contact the owner must type, or null when they need not.
 */
export function withoutContacts(text: string, kind: "email" | "whatsapp" | null): string {
  if (kind === "email") return text.replace(ADDRESS, "(an address: read it in the post)");
  if (kind === "whatsapp") return text.replace(NUMBER, "(a number: read it in the post)");
  return text;
}

/** A job's state in the owner's words, on the jobs list and the job page. */
export const STATE_WORDS: Readonly<Record<JobState, string>> = {
  manual_run: "Manual run",
  uploading: "Uploading",
  upload_failed: "Upload did not finish",
  queued: "Waiting to start",
  extracting: "Reading the post",
  needs_role_pick: "Pick a role",
  checking: "Checking eligibility",
  needs_eligibility_decision: "Eligibility needs your decision",
  needs_kit_type: "Pick a kit type",
  drafting: "Writing the email",
  judging: "Checking the email",
  kit_ready: "Ready to review",
  stopped: "Stopped",
  failed: "Failed",
  closed: "Closed",
};

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

/** What a duplicate match found, in the owner's words (ledger spec, "Duplicate check"). */
const DUPLICATE_WORDS: Readonly<Record<DuplicateMatch["reason"], string>> = {
  "company-role": "The same company and role",
  address: "The same address",
  post: "A post much like this one",
  drafted: "A kit already drafted for the same company and role",
};

/**
 * A duplicate match on the banner: what matched and the earlier
 * application, and where and when it was made. An imported application
 * has a day and no time, kept as the owner's list gives it.
 */
export function duplicateLine(
  match: DuplicateMatch,
  timeZone: string,
): { what: string; when: string } {
  const what = `${DUPLICATE_WORDS[match.reason]}: ${match.company || "a company it did not name"}, ${match.role || "a role it did not name"}`;
  switch (match.source) {
    case "application": {
      const how = match.bounced
        ? "sent with jobkit and bounced"
        : match.applied
          ? "applied with jobkit"
          : "drafted with jobkit and never sent";
      return { what, when: `${how}, ${formatTime(match.at, timeZone)}` };
    }
    case "manual-run":
      return { what, when: `a manual run, ${formatTime(match.at, timeZone)}` };
    case "earlier": {
      const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
      return { what, when: `an earlier application, ${day.format(match.at)}` };
    }
  }
}

const PARTS: Readonly<Record<string, string>> = {
  roles: "Role",
  requirements: "requirement",
  screening_questions: "question",
  instructions: "instruction",
  scam_signals: "scam sign",
  places: "place",
};

/** Where a record flag points, in the owner's words: "roles[1].requirements[2].id" is "Role 2, requirement 3". */
export function placeOfFlag(path: string): string {
  const named = [...path.matchAll(/([a-z_]+)\[(\d+)\]/g)]
    .filter(([, part]) => PARTS[part!] !== undefined)
    .map(([, part, index]) => `${PARTS[part!]} ${Number(index) + 1}`);
  if (path.includes(".route.")) named.push("contact");
  return named.join(", ");
}
