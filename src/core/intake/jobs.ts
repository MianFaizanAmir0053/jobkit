import { createJob, expireUploads, loadJob, moveJob } from "@/core/platform/jobs";
import { tileCount } from "@/core/shared/tileGeometry";
import type { Clock, Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { type ImageMeta, MAX_HELD_MS, refusal } from "./limits";
import { linksIn } from "./links";

export { type ImageMeta, LIMITS } from "./limits";

/**
 * Starting a job from what the phone sends (intake spec, "Upload path").
 * The request carries only metadata: each image's type, size, dimensions
 * and SHA-256, the pasted text and how long the phone held the job. The
 * server checks every limit again, creates the job with its image rows, and
 * hands back one signed upload URL per image; the phone uploads the bytes
 * straight to storage, and `confirmUploads` checks they all arrived before
 * the job is queued. When the page reloads or the connection drops,
 * `reissueUploads` gives fresh URLs for the files not yet stored. The job
 * keeps how it came in and the links its post gives, which are never
 * fetched, and every upload attempt is logged with its outcome (ledger
 * spec, "Records"). No arm is drawn: before real use there is none (ledger
 * spec), and intake draws one once real use starts.
 */

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const CLOCK_WRONG = "The page's clock went wrong. Reload the page and press Start again.";

const EXTENSIONS = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const satisfies Record<ImageMeta["contentType"], string>;

export interface NewJob {
  images: readonly ImageMeta[];
  pastedText: string;
  clientElapsedMs: number;
  /** Where the job came from: the New job page (the default) or the share target. */
  inputKind?: "page" | "share";
  /** A share's url field, a link kept as the post's first. */
  sharedUrl?: string;
}

export type StartResult =
  | { ok: true; jobId: string; uploads: { imageId: string; url: string }[]; queued: boolean }
  | { ok: false; message: string };

type Deps = { db: Db; clock: Clock; storage: Storage };

/**
 * Creates the job. `receivedAt` is when its request reached the server,
 * from which the job's start is counted back (intake spec, "Clock").
 */
export async function startJob(
  deps: Deps,
  job: NewJob,
  receivedAt: Date = deps.clock.now(),
): Promise<StartResult> {
  // Exact repeats within one job are dropped, the first kept.
  const seen = new Set<string>();
  const images = job.images.filter((image) => !seen.has(image.sha256) && seen.add(image.sha256));
  // A NUL character means nothing in a post, and Postgres text cannot hold one.
  const pastedText = job.pastedText.split(String.fromCharCode(0)).join("");
  const refused = refusal(images, pastedText);
  if (refused) return { ok: false, message: refused };
  if (job.clientElapsedMs > MAX_HELD_MS) return { ok: false, message: CLOCK_WRONG };

  const now = deps.clock.now();
  const purgeAfter = new Date(now.getTime() + RETENTION_MS);
  return deps.db.tx(async (tx) => {
    const jobId = await createJob(tx, {
      state: "uploading",
      receivedAt,
      clientElapsedMs: job.clientElapsedMs,
    });
    await tx.query(
      "update {{schema}}.jobs set pasted_text = $2, input_kind = $3, post_links = $4 where id = $1",
      [
        jobId,
        pastedText.trim() === "" ? null : pastedText,
        job.inputKind ?? "page",
        linksIn(job.sharedUrl ?? "", pastedText),
      ],
    );
    const uploads: { imageId: string; url: string }[] = [];
    for (const [position, image] of images.entries()) {
      const { rows } = await tx.query<{ id: string; storage_path: string }>(
        `insert into {{schema}}.job_images
           (id, job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
            tile_count, created_at, purge_after)
         select fresh.id, $1::uuid, $2, 'post', 'jobs/' || $1::text || '/' || fresh.id || '.' || $3::text, $4, $5, $6, $7, $8, $9, $10, $11
           from (select gen_random_uuid() as id) as fresh
         returning id, storage_path`,
        [
          jobId,
          position,
          EXTENSIONS[image.contentType],
          image.contentType,
          image.width,
          image.height,
          image.bytes,
          image.sha256,
          tileCount(image.width, image.height),
          now,
          purgeAfter,
        ],
      );
      const row = rows[0]!;
      const { url } = await deps.storage.createSignedUploadUrl(row.storage_path);
      uploads.push({ imageId: row.id, url });
    }
    if (images.length > 0) {
      await startAttempt(
        tx,
        jobId,
        images.map((image) => image.bytes),
        now,
      );
    }
    // A paste-only job has nothing to upload, so it is ready at once.
    const queued =
      images.length === 0 &&
      (await moveJob(tx, jobId, { from: "uploading", to: "queued", pending: null, at: now }));
    return { ok: true, jobId, uploads, queued };
  });
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-uploading" | "upload-failed" }
  | { ok: false; reason: "missing"; missing: string[] };

/**
 * Checks that every image of an uploading job is stored at its declared
 * size (intake spec, "Upload path", step 4), from storage's metadata alone,
 * so no image's bytes pass through the request. Then it queues the job. A
 * job with an image missing or of the wrong size stays uploading, and the
 * IDs of those images come back, so the phone can upload them again. A job
 * past its upload timeout has failed. Whether the bytes are the ones the
 * phone hashed, extract checks when it reads them, and it cuts tiles by the
 * stored image's own size, refusing one too tall or too wide, so the tile
 * and size limits hold for what was uploaded. The width, height and tile
 * count stored for each image are the phone's word.
 */
export async function confirmUploads(deps: Deps, jobId: string): Promise<ConfirmResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  await expireUploads(deps.db, deps.clock.now(), jobId);
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state === "upload_failed") return { ok: false, reason: "upload-failed" };
  if (job.state !== "uploading") return { ok: false, reason: "not-uploading" };
  const { rows } = await deps.db.query<{ id: string; storage_path: string; bytes: number }>(
    `select id, storage_path, bytes from {{schema}}.job_images
      where job_id = $1 order by purpose, position`,
    [jobId],
  );
  const missing: string[] = [];
  for (const row of rows) {
    const stored = await deps.storage.stat(row.storage_path);
    if (stored?.size !== row.bytes) missing.push(row.id);
  }
  if (missing.length > 0) return { ok: false, reason: "missing", missing };
  const at = deps.clock.now();
  const moved = await deps.db.tx(async (tx) => {
    const queued = await moveJob(tx, jobId, {
      from: "uploading",
      to: "queued",
      pending: null,
      at,
      ifChangedAt: job.stateChangedAt,
    });
    if (queued) await endAttempt(tx, jobId, "ok", at);
    return queued;
  });
  if (moved) return { ok: true };
  // Something moved the job meanwhile: the upload timeout, or a confirm before this one.
  const now = await loadJob(deps.db, jobId);
  return { ok: false, reason: now?.state === "upload_failed" ? "upload-failed" : "not-uploading" };
}

export type ReissueResult =
  | { ok: true; uploads: { imageId: string; url: string }[] }
  | { ok: false; reason: "not-found" | "not-uploading" | "upload-failed" };

/**
 * Fresh upload URLs for the files of an uploading job not yet stored at
 * their declared size (intake spec, "Upload path", step 3): after the page
 * reloaded or the connection dropped. A file of the wrong size is removed
 * first, since a signed URL never replaces one. The attempt before ends as
 * failed and a new one starts with the files left; when every file arrived,
 * none is given, and the phone goes on to confirm.
 */
export async function reissueUploads(deps: Deps, jobId: string): Promise<ReissueResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  await expireUploads(deps.db, deps.clock.now(), jobId);
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state === "upload_failed") return { ok: false, reason: "upload-failed" };
  if (job.state !== "uploading") return { ok: false, reason: "not-uploading" };
  const { rows } = await deps.db.query<{ id: string; storage_path: string; bytes: number }>(
    `select id, storage_path, bytes from {{schema}}.job_images
      where job_id = $1 order by purpose, position`,
    [jobId],
  );
  const left: typeof rows = [];
  const wrong: string[] = [];
  for (const row of rows) {
    const stored = await deps.storage.stat(row.storage_path);
    if (stored?.size === row.bytes) continue;
    left.push(row);
    if (stored) wrong.push(row.storage_path);
  }
  if (left.length === 0) return { ok: true, uploads: [] };
  if (wrong.length > 0) await deps.storage.remove(wrong);
  const uploads: { imageId: string; url: string }[] = [];
  for (const row of left) {
    const { url } = await deps.storage.createSignedUploadUrl(row.storage_path);
    uploads.push({ imageId: row.id, url });
  }
  const at = deps.clock.now();
  return deps.db.tx(async (tx): Promise<ReissueResult> => {
    // Under the job's lock, so two requests at once start one attempt each, one after the other.
    const { rows: locked } = await tx.query<{ state: string }>(
      "select state from {{schema}}.jobs where id = $1 for update",
      [jobId],
    );
    if (locked[0]?.state !== "uploading") return { ok: false, reason: "not-uploading" };
    await endAttempt(tx, jobId, "failed", at);
    await startAttempt(
      tx,
      jobId,
      left.map((row) => row.bytes),
      at,
    );
    return { ok: true, uploads };
  });
}

/** Starts the job's upload attempt with these files' sizes. */
async function startAttempt(db: Db, jobId: string, sizes: readonly number[], at: Date) {
  await db.query(
    `insert into {{schema}}.upload_attempts (job_id, started_at, files, bytes)
     values ($1, $2, $3, $4)`,
    [jobId, at, sizes.length, sizes.reduce((sum, size) => sum + size, 0)],
  );
}

/** Ends the job's open upload attempt, if any, with its outcome. */
async function endAttempt(db: Db, jobId: string, outcome: "ok" | "failed", at: Date) {
  await db.query(
    `update {{schema}}.upload_attempts set outcome = $2, ended_at = $3
      where job_id = $1 and outcome is null`,
    [jobId, outcome, at],
  );
}
