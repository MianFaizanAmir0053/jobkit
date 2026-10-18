import { oneLine, wordLimitOf } from "@/core/drafting/build";
import type { DraftOutput } from "@/core/drafting/draftStage";
import type { JobRecord, Role } from "@/core/extraction/record";

/**
 * The checklist of what the post asks of applicants (review spec, "Job
 * page", item 3): each of the chosen role's instructions, marked applied
 * when drafting applied it (its subject format, a word limit it could
 * read, its keyword), else not applied, for the owner to see to; and the
 * lines aimed at AI, from every role once, since the model may record a
 * line about the whole post under one role: an instruction not followed,
 * a screening question not answered. Declining an applied one comes with
 * the block editor (Task 29), which runs validate again.
 */

export type ChecklistStatus = "applied" | "not_applied" | "not_followed" | "not_answered";

export interface ChecklistItem {
  text: string;
  status: ChecklistStatus;
}

/** What drafting applied, as the draft keeps it. */
type Applied = Pick<DraftOutput, "subjectFormat" | "wordLimit" | "keyword">;

export function checklistOf(record: JobRecord, role: Role, applied: Applied): ChecklistItem[] {
  const own = role.instructions
    .filter((line) => !line.addressed_to_ai)
    .map((line): ChecklistItem => {
      const used =
        line.kind === "subject_format"
          ? applied.subjectFormat !== null && line.value === applied.subjectFormat
          : line.kind === "word_limit"
            ? wordLimitOf(line) !== null
            : line.kind === "include_keyword"
              ? applied.keyword !== null && oneLine(line.value) === applied.keyword
              : false;
      return { text: line.text, status: used ? "applied" : "not_applied" };
    });
  // The chosen role's own first, then the other roles', each line once.
  const roles = [role, ...record.roles.filter((other) => other !== role)];
  const aimedAtAi = roles.flatMap((each) => [
    ...each.instructions
      .filter((line) => line.addressed_to_ai)
      .map((line): ChecklistItem => ({ text: line.text, status: "not_followed" })),
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
