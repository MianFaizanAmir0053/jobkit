import { tileCount } from "@/core/extraction/tileGeometry";
import { createJob, loadJob, moveJob } from "@/core/platform/jobs";
import type { Clock, Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

/**
 * Starting a job from what the phone sends (intake spec, "Upload path").
 * The request carries only metadata: each image's type, size, dimensions
 * and SHA-256, the pasted text and how long the phone held the job. The
 * server checks every limit again, creates the job with its image rows, and
 * hands back one signed upload URL per image; the phone uploads the bytes
 * straight to storage, and `confirmUploads` checks they all arrived before
 * the job is queued. No arm is drawn: before real use there is none (ledger
 * spec), and intake draws one once real use starts.
 */

export const LIMITS = {
  images: 8,
  imageBytes: 10 * 1024 * 1024,
  tiles: 20,
  textLength: 20_000,
} as const;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSIONS = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" } as const;

export interface ImageMeta {
  contentType: keyof typeof EXTENSIONS;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

export interface NewJob {
  images: readonly ImageMeta[];
  pastedText: string;
  clientElapsedMs: number;
}

export type StartResult =
  | { ok: true; jobId: string; uploads: { imageId: string; url: string }[]; queued: boolean }
  | { ok: false; message: string };

type Deps = { db: Db; clock: Clock; storage: Storage };

export async function startJob(deps: Deps, job: NewJob): Promise<StartResult> {
  // Exact repeats within one job are dropped, the first kept.
  const seen = new Set<string>();
  const images = job.images.filter((image) => !seen.has(image.sha256) && seen.add(image.sha256));
  const refused = refusal(images, job.pastedText);
  if (refused) return { ok: false, message: refused };

  const now = deps.clock.now();
  const purgeAfter = new Date(now.getTime() + RETENTION_MS);
  return deps.db.tx(async (tx) => {
    const jobId = await createJob(tx, {
      state: "uploading",
      receivedAt: now,
      clientElapsedMs: job.clientElapsedMs,
    });
    if (job.pastedText.trim() !== "") {
      await tx.query("update {{schema}}.jobs set pasted_text = $2 where id = $1", [
        jobId,
        job.pastedText,
      ]);
    }
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
    // A paste-only job has nothing to upload, so it is ready at once.
    const queued =
      images.length === 0 &&
      (await moveJob(tx, jobId, { from: "uploading", to: "queued", pending: null, at: now }));
    return { ok: true, jobId, uploads, queued };
  });
}

/** Intake's limits, checked again on the server; the message to show, or null. */
function refusal(images: readonly ImageMeta[], pastedText: string): string | null {
  if (images.length === 0 && pastedText.trim() === "") {
    return "Nothing to start: choose screenshots of the post, or paste its text.";
  }
  if (images.length > LIMITS.images) {
    return `At most ${LIMITS.images} screenshots per job. Remove some, or split the post into two jobs.`;
  }
  if (images.some((image) => image.bytes > LIMITS.imageBytes)) {
    return "A screenshot is larger than 10 MB. Take a smaller screenshot of that part.";
  }
  if (pastedText.length > LIMITS.textLength) {
    return "The pasted text is longer than 20,000 characters. Paste only the job post.";
  }
  const tiles = images.reduce((sum, image) => sum + tileCount(image.width, image.height), 0);
  if (tiles > LIMITS.tiles) {
    return "Too many screenshots for one job. Remove some, or split the post into two jobs.";
  }
  return null;
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-uploading" }
  | { ok: false; reason: "missing"; missing: string[] };

/**
 * Checks that every image of an uploading job is stored at the size its
 * metadata declared, then queues the job. A job with an image missing or of
 * the wrong size stays uploading, and the IDs of those images come back, so
 * the phone can upload them again.
 */
export async function confirmUploads(deps: Deps, jobId: string): Promise<ConfirmResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
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
  const moved = await moveJob(deps.db, jobId, {
    from: "uploading",
    to: "queued",
    pending: null,
    at: deps.clock.now(),
    ifChangedAt: job.stateChangedAt,
  });
  return moved ? { ok: true } : { ok: false, reason: "not-uploading" };
}
