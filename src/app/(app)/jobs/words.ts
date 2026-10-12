import type { JobState } from "@/core/platform/jobStates";

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
