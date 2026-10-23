import type { Clock, Db, Storage } from "@/core/ports";

/**
 * Intake's daily purge (intake spec, "Storage and retention"; platform B6),
 * idempotent, as the daily job may run twice:
 * - screenshots past `purge_after`, unless kept for evaluation, from storage
 *   and their rows;
 * - a job's crops (under `jobs/<id>/crops/`, with no row of their own) once
 *   none of its screenshots is left, so a kept job keeps them with its
 *   screenshots;
 * - objects under a job's path, outside its crops, that no row names, once
 *   the job has left `uploading`: one an upload begun again left, as a
 *   screenshot of the first upload arriving after Upload again replaced its
 *   rows (one arriving after a timeout alone lands at the path its row still
 *   names, and goes with that row); on a job that still takes
 *   screenshots (a ready kit, a stopped post), only once it is 30 days old,
 *   so an add uploaded but not yet confirmed is never taken from under it;
 * - pasted text older than 30 days, with the links found in the post, unless
 *   the job is kept for evaluation.
 * A job whose storage cannot be listed or cleared is left for the next run;
 * the others go on.
 */

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface IntakePurge {
  images: number;
  crops: number;
  strays: number;
  pastedTexts: number;
}

type Deps = { db: Db; clock: Clock; storage: Storage };

export async function purgeIntake(deps: Deps): Promise<IntakePurge> {
  const { db, storage } = deps;
  const now = deps.clock.now();

  const { rows: expired } = await db.query<{ id: string; storage_path: string }>(
    `select id, storage_path from {{schema}}.job_images
      where purge_after <= $1 and not kept_for_eval`,
    [now],
  );
  if (expired.length > 0) {
    // Storage first: a row left after a failed removal is removed by the next run.
    await storage.remove(expired.map((image) => image.storage_path));
    await db.query("delete from {{schema}}.job_images where id = any($1::uuid[])", [
      expired.map((image) => image.id),
    ]);
  }

  // Every job past uploading: its objects that no row names, and its crops once no screenshot is left.
  const { rows: jobs } = await db.query<{ id: string; paths: string[] | null; adding: boolean }>(
    `select job.id, array_agg(image.storage_path) filter (where image.id is not null) as paths,
            job.state in ('kit_ready', 'stopped') and job.received_at > $1 as adding
       from {{schema}}.jobs as job
       left join {{schema}}.job_images as image on image.job_id = job.id
      where job.state <> 'uploading'
      group by job.id`,
    [new Date(now.getTime() - RETENTION_MS)],
  );
  let crops = 0;
  let strays = 0;
  for (const job of jobs) {
    const named = new Set(job.paths ?? []);
    const cropFolder = `jobs/${job.id}/crops/`;
    let stored: string[];
    try {
      stored = await storage.list(`jobs/${job.id}`);
    } catch {
      continue;
    }
    const gone = stored.filter((path) =>
      path.startsWith(cropFolder) ? named.size === 0 : !job.adding && !named.has(path),
    );
    if (gone.length === 0) continue;
    try {
      await storage.remove(gone);
    } catch {
      continue;
    }
    crops += gone.filter((path) => path.startsWith(cropFolder)).length;
    strays += gone.filter((path) => !path.startsWith(cropFolder)).length;
  }

  const textsBefore = new Date(now.getTime() - RETENTION_MS);
  const texts = await db.query(
    `update {{schema}}.jobs as job set pasted_text = null, post_links = '{}'
      where (job.pasted_text is not null or job.post_links <> '{}')
        and job.received_at <= $1
        and not exists (select 1 from {{schema}}.job_images as image
                         where image.job_id = job.id and image.kept_for_eval)`,
    [textsBefore],
  );
  // The post's hashes go with its text: a share is matched to an earlier one only within the
  // comparison's four weeks (ledger spec, "The timing comparison").
  await db.query(
    `update {{schema}}.jobs as job set post_hashes = '{}'
      where job.post_hashes <> '{}' and job.received_at <= $1
        and not exists (select 1 from {{schema}}.job_images as image
                         where image.job_id = job.id and image.kept_for_eval)`,
    [textsBefore],
  );

  return { images: expired.length, crops, strays, pastedTexts: texts.rowCount };
}
