import type { StageName } from "@/core/platform/jobStates";

/** Each stage in the words the Stats and Spend pages use. */
export const STAGE_NAMES: Record<StageName, string> = {
  extract: "Read the post",
  extract_questions: "Read a form's new questions",
  eligibility: "Check eligibility",
  templates: "Draft from your templates",
  draft: "Write a draft with Gemini",
  draft_answers: "Answer new questions",
  address_read: "Read the contact again",
  address_checks: "Check the address",
  judge: "Check every sentence separately",
};
