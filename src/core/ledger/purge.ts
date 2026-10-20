import type { Clock, Db } from "@/core/ports";

/**
 * The ledger's daily purge (ledger spec, "Retention"; amendment A7),
 * idempotent: a job's extracted record, drafts and recruiter names go 180
 * days after the last status change of its applications, and 30 days after
 * the last state change of a job that never got an application (stopped,
 * closed before a role, failed, upload_failed). What goes:
 * - every stage run's output and error, where the record, the drafts, the
 *   contact's reads and the checks live; the runs themselves stay, without
 *   them, for the Stats page's times;
 * - the review page's decisions on the job's kits, which hold post text
 *   (scam quotes, attachment names, the typed contact);
 * - the application's final draft and its post fingerprint.
 * The application row keeps its company, role, route, dates, status and the
 * address or number, for the duplicate check; draft outcomes and sends keep
 * no post text and stay.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeLedger(deps: { db: Db; clock: Clock }): Promise<{ jobs: number }> {
  const now = deps.clock.now().getTime();
  const { rows } = await deps.db.query<{ id: string }>(
    `select job.id from {{schema}}.jobs as job
      where (exists (select 1 from {{schema}}.applications as a where a.job_id = job.id)
             and not exists (select 1 from {{schema}}.applications as a
                              where a.job_id = job.id and a.status_changed_at > $1))
         or (not exists (select 1 from {{schema}}.applications as a where a.job_id = job.id)
             and job.state in ('stopped', 'closed', 'failed', 'upload_failed')
             and job.state_changed_at <= $2)`,
    [new Date(now - 180 * DAY_MS), new Date(now - 30 * DAY_MS)],
  );
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { jobs: 0 };
  return deps.db.tx(async (tx) => {
    const runs = await tx.query<{ job_id: string }>(
      `update {{schema}}.job_stage_runs set output = null, error = null
        where job_id = any($1::uuid[]) and (output is not null or error is not null)
        returning job_id`,
      [ids],
    );
    const reviews = await tx.query<{ job_id: string }>(
      "delete from {{schema}}.kit_reviews where job_id = any($1::uuid[]) returning job_id",
      [ids],
    );
    const applications = await tx.query<{ job_id: string }>(
      `update {{schema}}.applications set final_draft = null, post_fingerprint = '{}'
        where job_id = any($1::uuid[]) and (final_draft is not null or post_fingerprint <> '{}')
        returning job_id`,
      [ids],
    );
    const purged = new Set(
      [...runs.rows, ...reviews.rows, ...applications.rows].map((row) => row.job_id),
    );
    return { jobs: purged.size };
  });
}
