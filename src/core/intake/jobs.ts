import { spendState } from "@/core/ledger/spend";
import { createJob, expireUploads, loadJob, moveJob } from "@/core/platform/jobs";
import { tileCount } from "@/core/shared/tileGeometry";
import type { Clock, Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { withoutHidden } from "./hidden";
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

/** New jobs stop at the monthly spend cap (ledger spec, "Spend cap"). */
export const CAP_REACHED =
  "This month's model spend has reached its cap for new jobs, so jobkit starts none until next month.";

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
  const pastedText = withoutHidden(job.pastedText);
  const sharedUrl = withoutHidden(job.sharedUrl ?? "");
  const refused = refusal(images, pastedText);
  if (refused) return { ok: false, message: refused };
  if (job.clientElapsedMs > MAX_HELD_MS) return { ok: false, message: CLOCK_WRONG };
  if (!(await spendState(deps)).newJobsAllowed) return { ok: false, message: CAP_REACHED };

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
        linksIn(sharedUrl, pastedText),
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
  // Something moved the job meanwhile: the upload timeout, a confirm before this one, or the
  // timeout and then Upload again on the other device, which began another upload.
  const now = await loadJob(deps.db, jobId);
  const failed =
    now?.state === "upload_failed" ||
    (now?.state === "uploading" && now.stateChangedAt.getTime() !== job.stateChangedAt.getTime());
  return { ok: false, reason: failed ? "upload-failed" : "not-uploading" };
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
    // Under the job's lock, so two requests at once start one attempt each, one after the other,
    // and with its timeout applied again, since the URLs took time to make.
    await expireUploads(tx, at, jobId);
    const { rows: locked } = await tx.query<{ state: string; state_changed_at: Date }>(
      "select state, state_changed_at from {{schema}}.jobs where id = $1 for update",
      [jobId],
    );
    if (locked[0]?.state === "upload_failed") return { ok: false, reason: "upload-failed" };
    if (locked[0]?.state !== "uploading") return { ok: false, reason: "not-uploading" };
    // Uploading again since the page read it, as after Upload again on the other device: the
    // upload this page carried failed, and its files are not the job's any more.
    if (locked[0].state_changed_at.getTime() !== job.stateChangedAt.getTime()) {
      return { ok: false, reason: "upload-failed" };
    }
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

export type AgainResult =
  | { ok: true; jobId: string; uploads: { imageId: string; url: string }[] }
  | { ok: false; reason: "not-found" | "not-failed" }
  | { ok: false; message: string };

const NOTHING_AGAIN = "Choose the screenshots of the post again.";

/**
 * "Upload again" on a job whose upload failed (intake spec, "Upload path",
 * step 5; platform spec B9): the owner chooses the screenshots again, and
 * the phone prepares them as for a new job. The server checks every limit
 * again, and the spend cap as for a new job, since the job has not run.
 * In one transaction it replaces all the job's screenshots with these,
 * moves the job back to uploading, which starts its 15 minutes again, and
 * starts an upload attempt with them; it hands back one signed upload URL
 * per screenshot, and the phone uploads and confirms them as for a new
 * job. Whatever arrived of the failed upload is removed, by `later` when
 * given, once the answer has gone. The job keeps its pasted text, its links
 * and when it was received.
 *
 * Pressed again with the same screenshots while their upload runs, as
 * after an answer that was lost or an upload that did not finish, it sends
 * them again from the start within the same 15 minutes: what arrived is
 * removed, the attempt before ends as failed and a new one starts, and a
 * fresh URL comes back for each. Other screenshots wait until the upload
 * runs out of time.
 */
export async function uploadAgain(
  deps: Deps,
  jobId: string,
  chosen: readonly ImageMeta[],
  later?: (task: () => Promise<unknown>) => void,
): Promise<AgainResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  // Exact repeats are dropped, the first kept, as for a new job.
  const seen = new Set<string>();
  const images = chosen.filter((image) => !seen.has(image.sha256) && seen.add(image.sha256));
  await expireUploads(deps.db, deps.clock.now(), jobId);
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state === "uploading") return sendingAgain(deps, job.id, job.stateChangedAt, images);
  if (job.state !== "upload_failed") return { ok: false, reason: "not-failed" };
  if (images.length === 0) return { ok: false, message: NOTHING_AGAIN };
  const refused = refusal(images, "");
  if (refused) return { ok: false, message: refused };
  if (!(await spendState(deps)).newJobsAllowed) return { ok: false, message: CAP_REACHED };

  const now = deps.clock.now();
  const purgeAfter = new Date(now.getTime() + RETENTION_MS);
  const replaced = await deps.db.tx(async (tx) => {
    const moved = await moveJob(tx, jobId, {
      from: "upload_failed",
      to: "uploading",
      pending: null,
      at: now,
      ifChangedAt: job.stateChangedAt,
    });
    if (!moved) return null;
    const { rows: before } = await tx.query<{ storage_path: string }>(
      "delete from {{schema}}.job_images where job_id = $1 returning storage_path",
      [jobId],
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
    await startAttempt(
      tx,
      jobId,
      images.map((image) => image.bytes),
      now,
    );
    return { uploads, before: before.map((row) => row.storage_path) };
  });
  // Another tap, here or on the other device, uploaded it again first.
  if (!replaced) return { ok: false, reason: "not-failed" };
  // What arrived of the failed upload goes, under paths no row names any more; a removal that
  // fails leaves it for the purge.
  if (replaced.before.length > 0) {
    const remove = () => deps.storage.remove(replaced.before).catch(() => undefined);
    if (later) later(remove);
    else await remove();
  }
  return { ok: true, jobId, uploads: replaced.uploads };
}

/**
 * The same screenshots pressed again while their upload runs: each is sent
 * again from the start, within the same 15 minutes, as one attempt more.
 */
async function sendingAgain(
  deps: Deps,
  jobId: string,
  began: Date,
  images: readonly ImageMeta[],
): Promise<AgainResult> {
  const { rows } = await deps.db.query<{
    id: string;
    storage_path: string;
    bytes: number;
    sha256: string;
  }>(
    `select id, storage_path, bytes, sha256 from {{schema}}.job_images
      where job_id = $1 and purpose = 'post' order by position`,
    [jobId],
  );
  const same =
    rows.length === images.length &&
    rows.every((row, i) => row.sha256 === images[i]!.sha256 && row.bytes === images[i]!.bytes);
  if (!same) return { ok: false, reason: "not-failed" };
  // A signed URL never replaces a file, so what arrived goes first; it is sent again anyway.
  await deps.storage.remove(rows.map((row) => row.storage_path));
  const uploads: { imageId: string; url: string }[] = [];
  for (const row of rows) {
    const { url } = await deps.storage.createSignedUploadUrl(row.storage_path);
    uploads.push({ imageId: row.id, url });
  }
  const at = deps.clock.now();
  return deps.db.tx(async (tx): Promise<AgainResult> => {
    // Under the job's lock, as fresh URLs are given, with its timeout applied again.
    await expireUploads(tx, at, jobId);
    const { rows: locked } = await tx.query<{ state: string; state_changed_at: Date }>(
      "select state, state_changed_at from {{schema}}.jobs where id = $1 for update",
      [jobId],
    );
    if (
      locked[0]?.state !== "uploading" ||
      locked[0].state_changed_at.getTime() !== began.getTime()
    ) {
      return { ok: false, reason: "not-failed" };
    }
    await endAttempt(tx, jobId, "failed", at);
    await startAttempt(
      tx,
      jobId,
      rows.map((row) => row.bytes),
      at,
    );
    return { ok: true, jobId, uploads };
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
