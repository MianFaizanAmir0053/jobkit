import { createHash } from "node:crypto";

import sharp from "sharp";

import { createJob, expireUploads, loadJob, moveJob } from "@/core/platform/jobs";
import { tileCount } from "@/core/shared/tileGeometry";
import type { Clock, Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { type ImageMeta, refusal } from "./limits";

export { type ImageMeta, LIMITS } from "./limits";

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

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSIONS = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const satisfies Record<ImageMeta["contentType"], string>;

export interface NewJob {
  images: readonly ImageMeta[];
  pastedText: string;
  clientElapsedMs: number;
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

  const now = deps.clock.now();
  const purgeAfter = new Date(now.getTime() + RETENTION_MS);
  return deps.db.tx(async (tx) => {
    const jobId = await createJob(tx, {
      state: "uploading",
      receivedAt,
      clientElapsedMs: job.clientElapsedMs,
    });
    if (pastedText.trim() !== "") {
      await tx.query("update {{schema}}.jobs set pasted_text = $2 where id = $1", [
        jobId,
        pastedText,
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

export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-uploading" }
  | { ok: false; reason: "missing"; missing: string[] };

/**
 * Checks that every image of an uploading job is stored as its metadata
 * declared it: the same size, the same SHA-256, and an image of the declared
 * type and dimensions, so the limits checked at creation hold for what was
 * uploaded. Then it queues the job. A job with an image missing or not as
 * declared stays uploading, and the IDs of those images come back, so the
 * phone can upload them again. A job past its upload timeout has failed.
 */
export async function confirmUploads(deps: Deps, jobId: string): Promise<ConfirmResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  await expireUploads(deps.db, deps.clock.now(), jobId);
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "uploading") return { ok: false, reason: "not-uploading" };
  const { rows } = await deps.db.query<StoredImage>(
    `select id, storage_path, content_type, bytes, width, height, sha256
       from {{schema}}.job_images where job_id = $1 order by purpose, position`,
    [jobId],
  );
  const missing: string[] = [];
  for (const row of rows) {
    const stored = await deps.storage.get(row.storage_path);
    if (!stored || !(await asDeclared(stored, row))) missing.push(row.id);
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

type StoredImage = {
  id: string;
  storage_path: string;
  content_type: ImageMeta["contentType"];
  bytes: number;
  width: number;
  height: number;
  sha256: string;
};

const FORMATS: Record<ImageMeta["contentType"], string> = {
  "image/webp": "webp",
  "image/jpeg": "jpeg",
  "image/png": "png",
};

/** Whether stored bytes are the image declared: size, hash, then type and upright size from the header. */
async function asDeclared(bytes: Uint8Array, declared: StoredImage): Promise<boolean> {
  if (bytes.length !== declared.bytes) return false;
  if (createHash("sha256").update(bytes).digest("hex") !== declared.sha256) return false;
  try {
    const { format, width, height, orientation } = await sharp(bytes).metadata();
    // EXIF orientations 5 to 8 turn the image a quarter turn, swapping its sides.
    const [upright, tall] =
      orientation !== undefined && orientation >= 5 ? [height, width] : [width, height];
    return (
      format === FORMATS[declared.content_type] &&
      upright === declared.width &&
      tall === declared.height
    );
  } catch {
    return false;
  }
}
