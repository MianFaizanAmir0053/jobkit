import { randomUUID } from "node:crypto";

import { chosenRole } from "@/core/extraction/owner";
import { type ImageMeta, refusal } from "@/core/intake/limits";
import { loadJob, moveJob } from "@/core/platform/jobs";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db, Storage } from "@/core/ports";
import { tileCount } from "@/core/shared/tileGeometry";
import { isUuid } from "@/lib/uuid";

import { isLive, latestSend } from "./kitSends";

/**
 * "Add screenshots" on a job (intake spec, item 4): more of the post, which
 * moves the job to `extracting` for a fresh `extract`, or an application
 * form's questions, which runs `extract_questions`, then drafting and
 * judging for the new questions alone. As on New job, the phone uploads each
 * screenshot straight to storage with a signed URL (startAdd), then confirms
 * them (confirmAdd): only then do they become the job's, its images' rows
 * written and the job moved in one transaction, so an add left unconfirmed
 * changes nothing. Adding is open while the kit is ready and has not gone
 * (not sent, submitted, skipped, nor being sent), and, for the post, while
 * the job stopped at reading it; a form's questions only for a form's kit.
 * Each step names the job's state as the page showed it, and is refused
 * once the job moved on.
 */

export type Purpose = "post" | "form";

export interface AddRequest {
  purpose: Purpose;
  /** The job's state change the page showed. */
  since: Date;
}

export type AddRefusal =
  "not-found" | "moved-on" | "gone" | "not-a-form" | "nothing-new" | "missing" | "limits";

export type StartAddResult =
  | { ok: true; uploads: { sha256: string; path: string; url: string }[] }
  | { ok: false; reason: AddRefusal; message?: string };

export type ConfirmAddResult =
  { ok: true } | { ok: false; reason: AddRefusal; message?: string; missing?: string[] };

type Deps = { db: Db; clock: Clock; storage: Storage };

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSIONS = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const satisfies Record<ImageMeta["contentType"], string>;

const ALREADY_THE_JOBS = "These screenshots are already the job's.";

interface Stored extends ImageMeta {
  position: number;
}

/** The job's screenshots of one purpose, in order, as their rows keep them. */
async function imagesOf(db: Db, jobId: string, purpose: Purpose): Promise<Stored[]> {
  const { rows } = await db.query<{
    position: number;
    content_type: ImageMeta["contentType"];
    bytes: number;
    width: number;
    height: number;
    sha256: string;
  }>(
    `select position, content_type, bytes, width, height, sha256 from {{schema}}.job_images
      where job_id = $1 and purpose = $2 order by position`,
    [jobId, purpose],
  );
  return rows.map((row) => ({
    position: row.position,
    contentType: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
  }));
}

/** Why the job takes no screenshots of this purpose now; null when it does. */
async function closed(deps: Deps, jobId: string, request: AddRequest): Promise<AddRefusal | null> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return "not-found";
  if (job.stateChangedAt.getTime() !== request.since.getTime()) return "moved-on";
  const open = job.state === "kit_ready" || (request.purpose === "post" && job.state === "stopped");
  if (!open) return "moved-on";
  if (job.state !== "kit_ready") return null;
  const role = await chosenRole(deps.db, jobId);
  if (!role) return "moved-on";
  if (request.purpose === "form") {
    const draft = (await stageOutput(deps.db, jobId, "draft"))?.output as
      { kit?: { kind?: string } } | undefined;
    if (draft?.kit?.kind !== "form") return "not-a-form";
  }
  const { rows } = await deps.db.query<{ status: string }>(
    "select status from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, role.id],
  );
  const status = rows[0]?.status;
  if (status !== undefined && status !== "open" && status !== "kit_ready") return "gone";
  const send = await latestSend(deps.db, jobId, role.id);
  if (send && (send.status === "sent" || isLive(send, deps.clock.now()))) return "gone";
  return null;
}

/** The screenshots that are new to the job, and why they cannot be added, if they cannot. */
async function checked(
  deps: Deps,
  jobId: string,
  purpose: Purpose,
  images: readonly ImageMeta[],
): Promise<{ fresh: ImageMeta[] } | { reason: AddRefusal; message: string }> {
  const kept = await imagesOf(deps.db, jobId, purpose);
  const seen = new Set(kept.map((image) => image.sha256));
  const fresh = images.filter((image) => !seen.has(image.sha256) && seen.add(image.sha256));
  if (fresh.length === 0) return { reason: "nothing-new", message: ALREADY_THE_JOBS };
  // The post is read again whole, so its screenshots together keep the limits; a form's new
  // screenshots are read alone.
  let pastedText = "";
  if (purpose === "post") {
    const { rows } = await deps.db.query<{ pasted_text: string | null }>(
      "select pasted_text from {{schema}}.jobs where id = $1",
      [jobId],
    );
    pastedText = rows[0]?.pasted_text ?? "";
  }
  const message = refusal(purpose === "post" ? [...kept, ...fresh] : fresh, pastedText);
  return message ? { reason: "limits", message } : { fresh };
}

/** Signed upload URLs for the screenshots the owner adds, at paths of the job's own. */
export async function startAdd(
  deps: Deps,
  jobId: string,
  request: AddRequest & { images: readonly ImageMeta[] },
): Promise<StartAddResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const shut = await closed(deps, jobId, request);
  if (shut) return { ok: false, reason: shut };
  const images = await checked(deps, jobId, request.purpose, request.images);
  if ("reason" in images) return { ok: false, ...images };
  const uploads: { sha256: string; path: string; url: string }[] = [];
  for (const image of images.fresh) {
    const path = `jobs/${jobId}/${randomUUID()}.${EXTENSIONS[image.contentType]}`;
    const { url } = await deps.storage.createSignedUploadUrl(path);
    uploads.push({ sha256: image.sha256, path, url });
  }
  return { ok: true, uploads };
}

/**
 * Makes the uploaded screenshots the job's: each at a path of the job's own,
 * stored at its declared size, as confirmUploads checks a new job's; then,
 * in one transaction, their rows after the job's own of that purpose, and
 * the job to `extracting`, for `extract` or `extract_questions`.
 */
export async function confirmAdd(
  deps: Deps,
  jobId: string,
  request: AddRequest & { images: readonly (ImageMeta & { path: string })[] },
): Promise<ConfirmAddResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const shut = await closed(deps, jobId, request);
  if (shut) return { ok: false, reason: shut };
  const pattern = new RegExp(`^jobs/${jobId}/([0-9a-f-]{36})\\.(webp|jpg|png)$`);
  const named = request.images.map((image) => ({ image, id: pattern.exec(image.path)?.[1] }));
  if (
    named.some(
      ({ image, id }) =>
        id === undefined ||
        !isUuid(id) ||
        !image.path.endsWith(`.${EXTENSIONS[image.contentType]}`),
    ) ||
    new Set(request.images.map((image) => image.path)).size !== request.images.length
  ) {
    return { ok: false, reason: "missing", missing: request.images.map((image) => image.path) };
  }
  const images = await checked(deps, jobId, request.purpose, request.images);
  if ("reason" in images) return { ok: false, ...images };
  const fresh = new Set(images.fresh);
  const adding = named.filter(({ image }) => fresh.has(image));
  const missing: string[] = [];
  for (const { image } of adding) {
    const stored = await deps.storage.stat(image.path);
    if (stored?.size !== image.bytes) missing.push(image.path);
  }
  if (missing.length > 0) return { ok: false, reason: "missing", missing };

  const now = deps.clock.now();
  const job = (await loadJob(deps.db, jobId))!;
  const moved = await deps.db.tx(async (tx) => {
    const done = await moveJob(tx, jobId, {
      from: job.state,
      to: "extracting",
      pending: request.purpose === "form" ? "extract_questions" : "extract",
      at: now,
      ifChangedAt: request.since,
    });
    if (!done) return false;
    const { rows } = await tx.query<{ next: number }>(
      `select coalesce(max(position) + 1, 0)::int as next from {{schema}}.job_images
        where job_id = $1 and purpose = $2`,
      [jobId, request.purpose],
    );
    let position = rows[0]?.next ?? 0;
    for (const { image, id } of adding) {
      await tx.query(
        `insert into {{schema}}.job_images
           (id, job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
            tile_count, created_at, purge_after)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          jobId,
          position++,
          request.purpose,
          image.path,
          image.contentType,
          image.width,
          image.height,
          image.bytes,
          image.sha256,
          tileCount(image.width, image.height),
          now,
          new Date(now.getTime() + RETENTION_MS),
        ],
      );
    }
    return true;
  });
  return moved ? { ok: true } : { ok: false, reason: "moved-on" };
}
