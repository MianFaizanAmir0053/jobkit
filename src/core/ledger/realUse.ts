import type { Db, Random } from "@/core/ports";

import { type Arm, drawArm } from "./arms";

/**
 * Real use and the timing arms (ledger spec, "The timing comparison";
 * amendment A8). Real use starts at the first handoff of a kit made by
 * jobkit: the earliest of a handoff the review page recorded, an email
 * jobkit sent or was asked to send, and a kit marked sent or submitted (a
 * manual run's excepted), so a handoff whose record a redraft cleared still
 * counts by what followed it. For four weeks from then (A13's "to the end of
 * week 4", counted from real use as the MVP's calendar slipped: Claude's
 * choice, 2026-10-20), each new job is drawn into an arm when it is created:
 * the manual arm's job runs nothing (`manual_run`), and every other job made
 * in those weeks is the tool arm's. After them, no job has an arm.
 */

/** How long the comparison runs from the start of real use. */
export const COMPARISON_MS = 28 * 24 * 60 * 60 * 1000;

/** Whether a job created at `at` falls in the comparison's weeks. */
function inComparison(start: Date | null, at: Date): boolean {
  return (
    start !== null &&
    at.getTime() >= start.getTime() &&
    at.getTime() < start.getTime() + COMPARISON_MS
  );
}
export async function realUseStart(db: Db): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `select least(
       (select min(least((decisions->'handoff'->'subject'->>'at')::timestamptz,
                         (decisions->'handoff'->'body'->>'at')::timestamptz))
          from {{schema}}.kit_reviews),
       (select min(created_at) from {{schema}}.kit_sends),
       (select min(coalesce(sent_at, submitted_at)) from {{schema}}.applications
         where job_kind = 'real' and arm is distinct from 'manual'
           and coalesce(sent_at, submitted_at) is not null)
     ) as at`,
  );
  return rows[0]?.at ?? null;
}

/** The arm a job created at `at` goes to: none before real use, nor after its four weeks. */
export async function armForNewJob(
  deps: { db: Db; random: Random },
  at: Date,
): Promise<Arm | null> {
  if (!inComparison(await realUseStart(deps.db), at)) return null;
  return (await drawArm(deps)).arm;
}

/**
 * A job's arm for its application: the tool arm's when the job was created
 * once real use had started, as only the manual arm's jobs run nothing;
 * none before.
 */
export async function toolArmOf(db: Db, jobId: string): Promise<Arm | null> {
  const started = await realUseStart(db);
  if (started === null) return null;
  const { rows } = await db.query<{ received_at: Date }>(
    "select received_at from {{schema}}.jobs where id = $1",
    [jobId],
  );
  const received = rows[0]?.received_at;
  return received !== undefined && inComparison(started, received) ? "tool" : null;
}
