import { acceptedInstructions, oneLine, wordLimitOf } from "@/core/drafting/build";
import type { DraftOutput } from "@/core/drafting/draftStage";
import { bodyWords } from "@/core/drafting/kit";
import { hasWord, isCheckable, type KitFlag } from "@/core/drafting/validate";
import type { JobRecord, Role } from "@/core/extraction/record";

/**
 * The checklist of what the post asks of applicants (review spec, "Job
 * page", item 3): each of the chosen role's instructions, marked applied
 * when drafting applied it (its subject format, a word limit at least the
 * one the draft kept, its keyword), or applied but missed (validate's flag
 * for the subject or the keyword stands; the body runs past the line's own
 * limit); a keyword drafting left out, as one that repeats a line aimed at
 * AI; a file to attach, when the post lists files below; else not
 * applied, for the owner to see to. And the lines aimed at AI, from every
 * role once, since the model may record a line about the whole post under
 * one role: an instruction not followed, or followed when the email's
 * body repeats its words as validate looks for them; a screening question
 * not answered. Declining an applied line comes with the block editor
 * (Task 29), which runs validate again.
 */

export type ChecklistStatus =
  | "applied"
  | "applied_missed"
  | "left_out"
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

/** The flag that says the email misses the subject format or the keyword drafting applied. */
const MISSED: Partial<Record<Role["instructions"][number]["kind"], KitFlag["kind"]>> = {
  subject_format: "subject_placeholder",
  include_keyword: "keyword_missing",
};

export function checklistOf(record: JobRecord, role: Role, drafted: Drafted): ChecklistItem[] {
  const raised = new Set(drafted.flags.map((flag) => flag.kind));
  const accepted = acceptedInstructions(role);
  // A draft from before drafting kept its subject format applied the accepted one.
  const subjectFormat =
    drafted.subjectFormat === undefined ? accepted.subjectFormat : drafted.subjectFormat;
  const words = bodyWords(drafted.kit);
  const own = role.instructions
    .filter((line) => !line.addressed_to_ai)
    .map((line): ChecklistItem => {
      if (line.kind === "attach_document") {
        return {
          text: line.text,
          status: role.required_attachments.length > 0 ? "attachment" : "not_applied",
        };
      }
      const limit = line.kind === "word_limit" ? wordLimitOf(line) : null;
      // The accepted keyword, which drafting left out when it repeats a line aimed at AI.
      if (
        line.kind === "include_keyword" &&
        drafted.keyword === null &&
        accepted.keyword !== null &&
        oneLine(line.value) === accepted.keyword
      ) {
        return { text: line.text, status: "left_out" };
      }
      const applied =
        line.kind === "subject_format"
          ? subjectFormat !== null && line.value === subjectFormat
          : line.kind === "word_limit"
            ? limit !== null && drafted.wordLimit <= limit
            : line.kind === "include_keyword"
              ? drafted.keyword !== null && oneLine(line.value) === drafted.keyword
              : false;
      const flagged = MISSED[line.kind];
      const missed =
        line.kind === "word_limit"
          ? limit !== null && words > limit
          : flagged !== undefined && raised.has(flagged);
      return {
        text: line.text,
        status: !applied ? "not_applied" : missed ? "applied_missed" : "applied",
      };
    });
  // Looked for in the body only, as validate looks: the subject, greeting and closing are jobkit's.
  const body = drafted.kit.blocks.map((block) => block.text).join("\n");
  const repeats = (value: string) => {
    const words = oneLine(value);
    return isCheckable(words) && hasWord(body, words, [...words].length < 3);
  };
  // The chosen role's own first, then the other roles', each line once.
  const roles = [role, ...record.roles.filter((other) => other.id !== role.id)];
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
