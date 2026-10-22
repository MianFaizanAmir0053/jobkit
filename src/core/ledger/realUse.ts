import type { Db, Random } from "@/core/ports";

import { type Arm, drawArm } from "./arms";

/**
 * Real use and the timing arms (ledger spec, "The timing comparison";
 * amendment A8). Real use starts at the first handoff of a kit made by
 * jobkit: the first of a handoff the review page recorded, an email jobkit
 * was asked to send, and a kit marked sent or submitted, on a real job and
 * never a manual run. It is recorded once, as it happens, and nothing moves
 * it after: not a later handoff, a redraft, a take-back nor the purge (the
 * owner's choice, 2026-10-22). For four weeks from then (A13's "to the end
 * of week 4", counted from real use as the MVP's calendar slipped: Claude's
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

/** When real use started, as it was recorded; null before. */
export async function realUseStart(db: Db): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    "select real_use_started_at as at from {{schema}}.measurement where id = 1",
  );
  return rows[0]?.at ?? null;
}

/**
 * Records that real use started at `at`, with an event on `jobId`: a
 * handoff, a send asked for, or a kit that went. Only a real job's event
 * starts it, never a test job's or a manual run's, and only the first: a
 * start once recorded never moves. Callers run it in the event's own
 * transaction, so the two stand or fall together.
 */
export async function noteRealUse(db: Db, jobId: string, at: Date): Promise<void> {
  await db.query(
    `insert into {{schema}}.measurement as measurement (id, real_use_started_at, real_use_job)
     select 1, $2::timestamptz, job.id from {{schema}}.jobs as job
      where job.id = $1 and job.kind = 'real' and job.arm is distinct from 'manual'
     on conflict (id) do update
       set real_use_started_at = excluded.real_use_started_at,
           real_use_job = excluded.real_use_job
     where measurement.real_use_started_at is null`,
    [jobId, at],
  );
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
