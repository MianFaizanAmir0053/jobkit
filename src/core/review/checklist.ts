import { oneLine, wordLimitOf } from "@/core/drafting/build";
import type { DraftOutput } from "@/core/drafting/draftStage";
import { hasWord, isCheckable, type KitFlag } from "@/core/drafting/validate";
import type { JobRecord, Role } from "@/core/extraction/record";

/**
 * The checklist of what the post asks of applicants (review spec, "Job
 * page", item 3): each of the chosen role's instructions, marked applied
 * when drafting applied it (its subject format, a word limit at least the
 * one the draft kept, its keyword), or applied but missed while validate's
 * flag for it stands; a file to attach, which the files below cover; else
 * not applied, for the owner to see to. And the lines aimed at AI, from
 * every role once, since the model may record a line about the whole post
 * under one role: an instruction not followed, or followed when the
 * email's body repeats its words as validate looks for them; a screening
 * question not answered. Declining an applied line comes with the block
 * editor (Task 29), which runs validate again.
 */

export type ChecklistStatus =
  | "applied"
  | "applied_missed"
  | "attachment"
  | "not_applied"
  | "not_followed"
  | "followed"
  | "not_answered";

export interface ChecklistItem {
  text: string;
  status: ChecklistStatus;
}

/** What drafting applied, the flags validate raised on it, and the email, as the draft keeps them. */
type Drafted = Pick<DraftOutput, "subjectFormat" | "wordLimit" | "keyword" | "flags" | "kit">;

/** The flag that says the email misses each kind of line drafting applies. */
const MISSED: Partial<Record<Role["instructions"][number]["kind"], KitFlag["kind"]>> = {
  subject_format: "subject_placeholder",
  word_limit: "over_limit",
  include_keyword: "keyword_missing",
};

export function checklistOf(record: JobRecord, role: Role, drafted: Drafted): ChecklistItem[] {
  const raised = new Set(drafted.flags.map((flag) => flag.kind));
  const own = role.instructions
    .filter((line) => !line.addressed_to_ai)
    .map((line): ChecklistItem => {
      if (line.kind === "attach_document") return { text: line.text, status: "attachment" };
      const limit = line.kind === "word_limit" ? wordLimitOf(line) : null;
      const applied =
        line.kind === "subject_format"
          ? drafted.subjectFormat !== null && line.value === drafted.subjectFormat
          : line.kind === "word_limit"
            ? limit !== null && drafted.wordLimit <= limit
            : line.kind === "include_keyword"
              ? drafted.keyword !== null && oneLine(line.value) === drafted.keyword
              : false;
      const missed = MISSED[line.kind];
      return {
        text: line.text,
        status: !applied
          ? "not_applied"
          : missed !== undefined && raised.has(missed)
            ? "applied_missed"
            : "applied",
      };
    });
  // Looked for in the body only, as validate looks: the subject, greeting and closing are jobkit's.
  const body = drafted.kit.blocks.map((block) => block.text).join("\n");
  const repeats = (value: string) => {
    const words = oneLine(value);
    return isCheckable(words) && hasWord(body, words, [...words].length < 3);
  };
  // The chosen role's own first, then the other roles', each line once.
  const roles = [role, ...record.roles.filter((other) => other !== role)];
  const aimedAtAi = roles.flatMap((each) => [
    ...each.instructions
      .filter((line) => line.addressed_to_ai)
      .map((line): ChecklistItem => ({
        text: line.text,
        status: repeats(line.value) ? "followed" : "not_followed",
      })),
    ...each.screening_questions
      .filter((question) => question.addressed_to_ai)
      .map((question): ChecklistItem => ({ text: question.text, status: "not_answered" })),
  ]);
  const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    ...own,
    ...aimedAtAi.filter(
      (item, i) => aimedAtAi.findIndex((other) => key(other.text) === key(item.text)) === i,
    ),
  ];
}
