import type { Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

/**
 * "Keep for evaluation" on the job page (evals spec, "Case sources", live
 * cases): every image of the job is kept from the purge until `npm run
 * eval:pull` copies it into a case, which lets it go, or the owner lets it
 * go again. The keep flag lives on the images, so a job of pasted text
 * alone cannot be kept yet.
 */
export async function keepForEvaluation(
  db: Db,
  jobId: string,
  kept: boolean,
): Promise<{ ok: true; kept: boolean } | { ok: false; reason: "not-found" | "no-images" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const { rows } = await db.query<{ id: string }>(
    "update {{schema}}.job_images set kept_for_eval = $2 where job_id = $1 returning id",
    [jobId, kept],
  );
  if (rows.length > 0) return { ok: true, kept };
  const job = await db.query("select 1 from {{schema}}.jobs where id = $1", [jobId]);
  return { ok: false, reason: job.rows.length > 0 ? "no-images" : "not-found" };
}

/** Whether the job is kept for evaluation; null for a job with no image to keep. */
export async function keptForEvaluation(db: Db, jobId: string): Promise<boolean | null> {
  if (!isUuid(jobId)) return null;
  const { rows } = await db.query<{ kept: boolean | null }>(
    "select bool_or(kept_for_eval) as kept from {{schema}}.job_images where job_id = $1",
    [jobId],
  );
  return rows[0]?.kept ?? null;
}
