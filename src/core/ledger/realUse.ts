import type { Db, Random } from "@/core/ports";

import { type Arm, drawArm } from "./arms";

/**
 * Real use and the timing arms (ledger spec, "The timing comparison";
 * amendment A8). Real use starts at the first handoff of a kit made by
 * jobkit: the earliest of a handoff the review page recorded, an email
 * jobkit sent or was asked to send, and a kit marked sent or submitted (a
 * manual run's excepted), so a handoff whose record a redraft cleared still
 * counts by what followed it. From then, each new job is drawn into an arm
 * when it is created: the manual arm's job runs nothing (`manual_run`), and
 * every other job made since is the tool arm's.
 */
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

/** The arm a job created now goes to: none before real use. */
export async function armForNewJob(deps: { db: Db; random: Random }): Promise<Arm | null> {
  if ((await realUseStart(deps.db)) === null) return null;
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
  return received !== undefined && received.getTime() >= started.getTime() ? "tool" : null;
}
