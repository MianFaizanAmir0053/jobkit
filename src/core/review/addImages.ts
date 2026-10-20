import { randomUUID } from "node:crypto";

import { stopReasonOf } from "@/core/extraction/extract";
import { chosenRole, currentExtraction } from "@/core/extraction/owner";
import { type ImageMeta, refusal } from "@/core/intake/limits";
import { CAP_REACHED } from "@/core/intake/jobs";
import { spendState } from "@/core/ledger/spend";
import { loadJob, moveJob } from "@/core/platform/jobs";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db, Storage } from "@/core/ports";
import { tileCount } from "@/core/shared/tileGeometry";
import { isUuid } from "@/lib/uuid";

import { latestSend } from "./kitSends";
import { lockReview } from "./markSent";

/**
 * "Add screenshots" on a job (intake spec, item 4): more of the post, which
 * moves the job to `extracting` for a fresh `extract`, or an application
 * form's questions, which runs `extract_questions`, then drafting and
 * judging for the new questions alone. As on New job, the phone uploads each
 * screenshot straight to storage with a signed URL (startAdd), then confirms
 * them (confirmAdd): only then do they become the job's, its images' rows
 * written and the job moved in one transaction, so an add left unconfirmed
 * changes nothing. Adding is open while the kit is ready and has not gone
 * (not sent, submitted, skipped, nor being or perhaps sent), and, for the
 * post, while the job stopped at reading it, but for a post in another
 * language, whose only way on is Skip; a form's questions only for a form's
 * kit; and only while new jobs may still spend. Each step names the job's
 * state as the page showed it, and is refused once the job moved on.
 */

export type Purpose = "post" | "form";

export interface AddRequest {
  purpose: Purpose;
  /** The job's state change the page showed. */
  since: Date;
}

export type AddRefusal =
  | "not-found"
  | "moved-on"
  | "gone"
  | "not-a-form"
  | "nothing-new"
  | "missing"
  | "limits"
  | "storage";

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

type Refused = { reason: AddRefusal; message?: string };

/**
 * The job's screenshots that count for an add: the post's, all of which it
 * reads whole, and the form's added since the current reading of the post,
 * the others' questions having gone with the reading they answered.
 */
async function imagesOf(db: Db, jobId: string, purpose: Purpose): Promise<ImageMeta[]> {
  const { rows } = await db.query<{
    content_type: ImageMeta["contentType"];
    bytes: number;
    width: number;
    height: number;
    sha256: string;
  }>(
    `select content_type, bytes, width, height, sha256 from {{schema}}.job_images
      where job_id = $1 and purpose = $2
        and (purpose = 'post' or created_at >= coalesce(
          (select max(ended_at) from {{schema}}.job_stage_runs
            where job_id = $1 and stage = 'extract' and outcome in ('ok', 'reused')),
          '-infinity'))
      order by position`,
    [jobId, purpose],
  );
  return rows.map((row) => ({
    contentType: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
  }));
}

/** Why the kit counts as gone: sent, submitted or skipped, or a send of it scheduled, under way or sent. */
async function gone(db: Db, jobId: string, roleId: string): Promise<boolean> {
  const { rows } = await db.query<{ status: string }>(
    "select status from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  const status = rows[0]?.status;
  if (status !== undefined && status !== "open" && status !== "kit_ready") return true;
  // One stuck in sending may have gone: the page warns of it, and nothing is added past it.
  const send = await latestSend(db, jobId, roleId);
  return send !== null && ["scheduled", "sending", "sent"].includes(send.status);
}

/** Why the job takes no screenshots of this purpose now; null when it does. */
async function closed(
  deps: Deps,
  jobId: string,
  request: AddRequest,
): Promise<{ refused: Refused } | { state: "kit_ready" | "stopped"; roleId: string | null }> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { refused: { reason: "not-found" } };
  if (job.stateChangedAt.getTime() !== request.since.getTime()) {
    return { refused: { reason: "moved-on" } };
  }
  if (job.state === "stopped" && request.purpose === "post") {
    const extraction = await currentExtraction(deps.db, jobId);
    // A post in another language has Skip as its only way on (extraction spec, B9).
    if (extraction && stopReasonOf(extraction) === "language") {
      return { refused: { reason: "moved-on" } };
    }
  } else if (job.state !== "kit_ready") return { refused: { reason: "moved-on" } };
  // Reading and answering spend as a new job does.
  if (!(await spendState(deps)).newJobsAllowed) {
    return { refused: { reason: "limits", message: CAP_REACHED } };
  }
  if (job.state === "stopped") return { state: "stopped", roleId: null };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { refused: { reason: "moved-on" } };
  if (request.purpose === "form") {
    const draft = (await stageOutput(deps.db, jobId, "draft"))?.output as
      { kit?: { kind?: string } } | undefined;
    if (draft?.kit?.kind !== "form") return { refused: { reason: "not-a-form" } };
  }
  if (await gone(deps.db, jobId, role.id)) return { refused: { reason: "gone" } };
  return { state: "kit_ready", roleId: role.id };
}

/**
 * The screenshots that are new to the job, and why they cannot be added, if
 * they cannot: a repeat of one the job counts, of either purpose, is dropped.
 */
async function checked(
  deps: Deps,
  jobId: string,
  purpose: Purpose,
  images: readonly ImageMeta[],
): Promise<{ fresh: ImageMeta[] } | Refused> {
  const post = await imagesOf(deps.db, jobId, "post");
  const form = await imagesOf(deps.db, jobId, "form");
  const seen = new Set([...post, ...form].map((image) => image.sha256));
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
  const message = refusal(purpose === "post" ? [...post, ...fresh] : fresh, pastedText);
  return message ? { reason: "limits", message } : { fresh };
}

/** Signed upload URLs for the screenshots the owner adds, at paths of the job's own. */
export async function startAdd(
  deps: Deps,
  jobId: string,
  request: AddRequest & { images: readonly ImageMeta[] },
): Promise<StartAddResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const open = await closed(deps, jobId, request);
  if ("refused" in open) return { ok: false, ...open.refused };
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
 * in one transaction, under the review row's lock as Mark sent and Mark
 * submitted take it, with the job and the kit checked again, their rows
 * after the job's own of that purpose, and the job to `extracting`, for
 * `extract` or `extract_questions`.
 */
export async function confirmAdd(
  deps: Deps,
  jobId: string,
  request: AddRequest & { images: readonly (ImageMeta & { path: string })[] },
): Promise<ConfirmAddResult> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const open = await closed(deps, jobId, request);
  if ("refused" in open) return { ok: false, ...open.refused };
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
  try {
    for (const { image } of adding) {
      const stored = await deps.storage.stat(image.path);
      if (stored?.size !== image.bytes) missing.push(image.path);
    }
  } catch {
    return { ok: false, reason: "storage" };
  }
  if (missing.length > 0) return { ok: false, reason: "missing", missing };

  const now = deps.clock.now();
  return deps.db.tx(async (tx): Promise<ConfirmAddResult> => {
    const at = { ...deps, db: tx };
    if (open.roleId !== null) await lockReview(at, jobId, open.roleId);
    // The job and the kit as they stand under the lock: another device may have moved either.
    const job = await loadJob(tx, jobId);
    if (job?.state !== open.state || job.stateChangedAt.getTime() !== request.since.getTime()) {
      return { ok: false, reason: "moved-on" };
    }
    if (open.roleId !== null && (await gone(tx, jobId, open.roleId))) {
      return { ok: false, reason: "gone" };
    }
    let moved: boolean;
    try {
      moved = await moveJob(tx, jobId, {
        from: open.state,
        to: "extracting",
        pending: request.purpose === "form" ? "extract_questions" : "extract",
        at: now,
        ifChangedAt: request.since,
      });
    } catch {
      moved = false;
    }
    if (!moved) return { ok: false, reason: "moved-on" };
    const { rows } = await tx.query<{ next: number; kept: boolean }>(
      `select coalesce(max(position) filter (where purpose = $2) + 1, 0)::int as next,
              coalesce(bool_or(kept_for_eval), false) as kept
         from {{schema}}.job_images where job_id = $1`,
      [jobId, request.purpose],
    );
    let position = rows[0]?.next ?? 0;
    for (const { image, id } of adding) {
      await tx.query(
        `insert into {{schema}}.job_images
           (id, job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
            tile_count, created_at, purge_after, kept_for_eval)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
          // A job kept for evaluation keeps what is added to it too.
          rows[0]?.kept ?? false,
        ],
      );
    }
    return { ok: true };
  });
}
