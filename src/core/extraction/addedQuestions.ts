import { z } from "zod";

import type { Db } from "@/core/ports";

import type { Role } from "./record";

/**
 * What `extract_questions` keeps (extraction spec, "Stage extract_questions"):
 * every question read from the form screenshots the owner added to a job,
 * for one reading of the post and one role, with IDs that continue the
 * role's (Q5, Q6, … after Q1 to Q4), and the screenshots read so far, so a
 * later batch reads only its own.
 */
export const addedQuestionsSchema = z.object({
  /** The `extract` output the questions add to. */
  extract: z.string(),
  role: z.string(),
  /** The form screenshots read so far, by hash, in the order read. */
  images: z.array(z.string()),
  questions: z.array(z.object({ id: z.string(), text: z.string(), addressed_to_ai: z.boolean() })),
});

export type AddedQuestions = z.output<typeof addedQuestionsSchema>;

/** extract_questions' stored output, or null when it is not one this version can read. */
export function readAddedQuestions(output: unknown): AddedQuestions | null {
  const parsed = addedQuestionsSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

/**
 * The role with the questions read from added form screenshots after its
 * own: those of the job's latest `extract_questions` run, when it added to
 * this reading of the post and this role. A fresh reading of the post drops
 * them, as its questions are numbered afresh.
 */
export async function withAddedQuestions(
  db: Db,
  jobId: string,
  extractHash: string,
  role: Role,
): Promise<Role> {
  const { rows } = await db.query<{ output: unknown }>(
    `select output from {{schema}}.job_stage_runs
      where job_id = $1 and stage = 'extract_questions' and outcome in ('ok', 'reused')
      order by id desc limit 1`,
    [jobId],
  );
  const added = readAddedQuestions(rows[0]?.output);
  if (!added || added.extract !== extractHash || added.role !== role.id) return role;
  return { ...role, screening_questions: [...role.screening_questions, ...added.questions] };
}
