import { refusal } from "@/core/intake/limits";
import { UPLOAD_TIMEOUT_MS } from "@/core/platform/jobs";

import { pendingUploads } from "./pendingUploads";
import { type Prepared, type PreparedImage, prepareImage } from "./prepare";

/**
 * What Start does (intake spec, "Upload path"): prepare each screenshot,
 * refuse what breaks intake's limits with the server's own words, create the
 * job with metadata only, upload each file straight to its URL, and ask the
 * server to confirm the files arrived. When some did not, the page asks for
 * fresh URLs for those and uploads them again, twice at most; and it keeps
 * the upload in the browser until the server has it, so New job finishes it
 * after a reload (step 3). The job's clock starts at the tap: Start calls
 * this at once, and it reads the time before anything else. The browser's
 * pieces come in as deps, so the flow is tested without a browser.
 */

/** An upload the page started, kept so a reload can finish it. */
export interface PendingUpload {
  jobId: string;
  /** When the page stops trying, by the wall clock: a minute before the server's 15 minutes. */
  deadlineAt: number;
  images: { imageId: string; blob: Blob }[];
}

/** Where the browser keeps uploads to finish (IndexedDB; pendingUploads.ts). */
export interface PendingUploads {
  save(upload: PendingUpload): Promise<void>;
  latest(): Promise<PendingUpload | null>;
  clear(jobId: string): Promise<void>;
}

export interface SubmitDeps {
  prepare: (file: File) => Promise<Prepared>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Monotonic milliseconds. */
  now: () => number;
  /** Wall-clock milliseconds, which a kept upload's deadline survives a reload in. */
  wallNow: () => number;
  wait: (ms: number) => Promise<void>;
  pending: PendingUploads;
}

export type Submitted = { ok: true; jobId: string } | { ok: false; message: string };

export const MESSAGES = {
  notStarted: "The job could not start. Try again.",
  createLost:
    "The connection dropped while the job was starting. Check the Jobs list before you press Start again: the job may have started.",
  confirmLost:
    "The upload could not be checked. Check the Jobs list before you press Start again: the job may have started.",
  checkJobs: "Then check the Jobs list before you press Start again: the job may have started.",
  signIn: "You are signed out. Sign in again, then press Start.",
  notAllowed:
    "This device cannot start jobs. Approve it on the laptop's Devices page, or sign in again.",
  badRequest:
    "The page sent something the server did not expect. Reload the page and press Start again.",
  tooLarge: "Too much text for one job. Paste only the job post.",
  notArrived: "Some screenshots did not arrive. Check the connection and press Start again.",
  refusedUpload:
    "Storage refused a screenshot. Press Start again; if it happens again, take a smaller screenshot.",
  tooSlow:
    "The upload is too slow to finish within 15 minutes. Press Start again on a faster connection.",
  uploadTimedOut:
    "The upload took more than 15 minutes, so it was stopped. Press Start again on a faster connection.",
  notFound: "The job could not be found. Press Start again.",
  notResumed:
    "The upload could not finish yet. Check the connection: jobkit tries again when you open New job.",
} as const;

/** How many times the page asks for fresh URLs for screenshots that did not arrive. */
export const RESUME_ROUNDS = 2;

/** Waits before the second and third attempt of a request. */
export const BACKOFF_MS = [1_000, 3_000] as const;

/** How long creating the job and checking the upload may take before the page stops waiting. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The server fails an upload 15 minutes after the job was created; the page
 * stops a minute earlier, counting from before it asked to create the job.
 */
export const UPLOAD_DEADLINE_MS = UPLOAD_TIMEOUT_MS - 60_000;

/**
 * One upload attempt may take half a minute plus the file's size at 16 KB a
 * second, the pace of a slow mobile connection: about five minutes for a
 * 4 MB screenshot.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil(bytes / 16);
}

export const browserDeps: SubmitDeps = {
  prepare: prepareImage,
  // Called through a wrapper: fetch detached from window throws in Chrome.
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
  wallNow: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pending: pendingUploads,
};

type Uploads = { imageId: string; url: string }[];

export async function submitJob(
  deps: SubmitDeps,
  input: {
    files: readonly File[];
    text: string;
    /** Where the job came from: the New job page, or a share. */
    inputKind?: "page" | "share";
    /** A share's url field, which the job keeps as a link. */
    sharedUrl?: string;
  },
  onStatus: (status: string) => void,
): Promise<Submitted> {
  const startedAt = deps.now();
  if (input.files.length > 0) onStatus("Preparing the screenshots…");
  const images: PreparedImage[] = [];
  const seen = new Set<string>();
  for (const file of input.files) {
    const prepared = await deps.prepare(file);
    if (!prepared.ok) return prepared;
    // The same screenshot twice is sent once.
    if (seen.has(prepared.meta.sha256)) continue;
    seen.add(prepared.meta.sha256);
    images.push(prepared);
  }
  const refused = refusal(
    images.map((image) => image.meta),
    input.text,
  );
  if (refused) return { ok: false, message: refused };

  onStatus("Starting the job…");
  // The server's upload clock starts when this request arrives; the page's starts sooner.
  const deadline = deps.now() + UPLOAD_DEADLINE_MS;
  const deadlineAt = deps.wallNow() + UPLOAD_DEADLINE_MS;
  let created: { jobId: string; uploads: Uploads };
  try {
    const response = await deps.fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: images.map((image) => image.meta),
        pastedText: input.text,
        inputKind: input.inputKind ?? "page",
        sharedUrl: input.sharedUrl ?? "",
        clientElapsedMs: Math.max(0, Math.round(deps.now() - startedAt)),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A server error may come after the job was created; so may an answer the page cannot read.
    if (response.status >= 500) return { ok: false, message: MESSAGES.createLost };
    if (!response.ok) return { ok: false, message: await createMessage(response) };
    created = (await response.json()) as typeof created;
    if (!Array.isArray(created.uploads)) throw new Error("no uploads");
  } catch {
    // The server may have created the job before the answer was lost.
    return { ok: false, message: MESSAGES.createLost };
  }
  if (created.uploads.length !== images.length) return { ok: false, message: MESSAGES.notStarted };
  if (images.length === 0) return { ok: true, jobId: created.jobId };

  const { jobId } = created;
  const blobs = new Map(created.uploads.map((upload, i) => [upload.imageId, images[i]!.blob]));
  // Kept until the server has it, so a reload can finish it; a browser that cannot keep it still uploads.
  await deps.pending
    .save({ jobId, deadlineAt, images: [...blobs].map(([imageId, blob]) => ({ imageId, blob })) })
    .catch(() => undefined);
  const uploaded = await uploadAll(deps, created.uploads, blobs, deadline, onStatus);
  if (uploaded) return settled(deps, jobId, uploaded);
  return finish(deps, jobId, blobs, deadline, onStatus);
}

/**
 * Finishes an upload a reload cut short (intake spec, "Upload path", step 3):
 * fresh URLs for the screenshots the server does not have yet, then the
 * confirmation. Null when no upload waits.
 */
export async function resumeUpload(
  deps: SubmitDeps,
  onStatus: (status: string) => void,
): Promise<Submitted | null> {
  const pending = await deps.pending.latest().catch(() => null);
  if (!pending) return null;
  onStatus("Finishing the upload of a job started before…");
  const left = pending.deadlineAt - deps.wallNow();
  if (left <= 0)
    return settled(deps, pending.jobId, { ok: false, message: MESSAGES.uploadTimedOut });
  const deadline = deps.now() + left;
  const blobs = new Map(pending.images.map((image) => [image.imageId, image.blob]));
  const fresh = await freshUploads(deps, pending.jobId);
  if (!Array.isArray(fresh)) return settled(deps, pending.jobId, fresh);
  const uploaded = await uploadAll(deps, fresh, blobs, deadline, onStatus);
  if (uploaded) return settled(deps, pending.jobId, uploaded);
  return finish(deps, pending.jobId, blobs, deadline, onStatus);
}

/** Uploads each file to its URL in turn; null when every one went, or why the upload stops. */
async function uploadAll(
  deps: SubmitDeps,
  uploads: Uploads,
  blobs: ReadonlyMap<string, Blob>,
  deadline: number,
  onStatus: (status: string) => void,
): Promise<Submitted | null> {
  for (const [i, upload] of uploads.entries()) {
    const blob = blobs.get(upload.imageId);
    if (!blob) return { ok: false, message: MESSAGES.notStarted };
    onStatus(`Uploading screenshot ${i + 1} of ${uploads.length}…`);
    const uploaded = await uploadFile(deps, upload.url, blob, deadline);
    if (uploaded === "too-slow") return { ok: false, message: MESSAGES.tooSlow };
    if (uploaded === "refused") return { ok: false, message: MESSAGES.refusedUpload };
  }
  return null;
}

/**
 * Confirms the upload; for screenshots that did not arrive, asks for fresh
 * URLs and uploads those again, twice at most, then confirms again.
 */
async function finish(
  deps: SubmitDeps,
  jobId: string,
  blobs: ReadonlyMap<string, Blob>,
  deadline: number,
  onStatus: (status: string) => void,
): Promise<Submitted> {
  for (let round = 0; ; round++) {
    onStatus("Checking the upload…");
    const confirmed = await confirmUpload(deps, jobId);
    if (confirmed !== "missing") return settled(deps, jobId, confirmed);
    // Kept: opening New job again tries once more while the server still waits for it.
    if (round === RESUME_ROUNDS) return { ok: false, message: MESSAGES.notArrived };
    const fresh = await freshUploads(deps, jobId);
    if (!Array.isArray(fresh)) return settled(deps, jobId, fresh);
    const uploaded = await uploadAll(deps, fresh, blobs, deadline, onStatus);
    if (uploaded) return settled(deps, jobId, uploaded);
  }
}

/**
 * Forgets a kept upload once nothing more can come of it: the server has it,
 * it ran out of time, the job is gone, or storage refused a screenshot. One
 * cut short by the connection or the session is kept to try again.
 */
async function settled(deps: SubmitDeps, jobId: string, outcome: Submitted): Promise<Submitted> {
  const over = [
    MESSAGES.uploadTimedOut,
    MESSAGES.notFound,
    MESSAGES.refusedUpload,
    MESSAGES.notStarted,
  ];
  // A message may carry the advice to check the Jobs list after it.
  const done = outcome.ok || over.some((message) => outcome.message.startsWith(message));
  if (done) await deps.pending.clear(jobId).catch(() => undefined);
  return outcome;
}

/**
 * Fresh URLs for the screenshots the server does not have yet, or what the
 * page should say: a job the server took already opens, one past its time
 * or gone says so, and anything else keeps the upload to try again.
 */
async function freshUploads(deps: SubmitDeps, jobId: string): Promise<Uploads | Submitted> {
  let response: Response;
  try {
    response = await deps.fetch(`/api/jobs/${jobId}/upload-urls`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: MESSAGES.notResumed };
  }
  const body = (await response.json().catch(() => null)) as {
    uploads?: unknown;
    error?: unknown;
  } | null;
  if (response.ok && Array.isArray(body?.uploads)) return body.uploads as Uploads;
  if (response.status === 409 && body?.error === "not-uploading") return { ok: true, jobId };
  if (response.status === 409 && body?.error === "upload-failed") {
    return { ok: false, message: MESSAGES.uploadTimedOut };
  }
  if (response.status === 404) return { ok: false, message: MESSAGES.notFound };
  return { ok: false, message: sessionMessage(response.status) ?? MESSAGES.notResumed };
}

/** The server's own words for a job it refused; otherwise what the owner can do about it. */
async function createMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (response.status === 422 && typeof body?.error === "string") return body.error;
  if (response.status === 413) return MESSAGES.tooLarge;
  return (
    sessionMessage(response.status) ??
    (response.status === 400 ? MESSAGES.badRequest : MESSAGES.notStarted)
  );
}

function sessionMessage(status: number): string | null {
  if (status === 401) return MESSAGES.signIn;
  if (status === 403) return MESSAGES.notAllowed;
  return null;
}

/**
 * Up to three attempts per file, waiting longer before each, each with a
 * timeout sized to the file and cut short at the deadline, so no attempt
 * runs past the server's 15 minutes. Only a dropped connection, a timeout
 * or a server error is tried again; any other answer is final, because a
 * signed URL takes one upload, and the confirm step then checks what arrived.
 */
async function uploadFile(
  deps: SubmitDeps,
  url: string,
  blob: Blob,
  deadline: number,
): Promise<"done" | "refused" | "too-slow"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await deps.wait(BACKOFF_MS[attempt - 1]!);
    const left = deadline - deps.now();
    if (left <= 0) return "too-slow";
    try {
      const response = await deps.fetch(url, {
        method: "PUT",
        body: blob,
        signal: AbortSignal.timeout(Math.min(uploadTimeoutMs(blob.size), left)),
      });
      // Too large or of a refused type: sending it again cannot help. Any other answer, such as
      // a URL used already by an attempt whose answer was lost, is left to the confirm step.
      if (response.status === 413 || response.status === 415) return "refused";
      if (response.status < 500) return "done";
    } catch {
      // A dropped connection or a timeout; try again.
    }
  }
  return "done";
}

/**
 * Asks the server to confirm the upload, up to three times while the
 * connection or the server fails. A job that the server finds already
 * queued or running was confirmed by an attempt whose answer was lost. Any
 * dropped connection, timeout or server error may have come after the job
 * was queued, so from then on every refusal says to check the Jobs list.
 */
async function confirmUpload(deps: SubmitDeps, jobId: string): Promise<Submitted | "missing"> {
  let uncertain = false;
  const failed = (message: string): Submitted => ({
    ok: false,
    message: uncertain ? `${message} ${MESSAGES.checkJobs}` : message,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await deps.wait(BACKOFF_MS[attempt - 1]!);
    let response: Response;
    try {
      response = await deps.fetch(`/api/jobs/${jobId}/uploaded`, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      uncertain = true;
      continue;
    }
    if (response.status >= 500) {
      uncertain = true;
      continue;
    }
    if (response.ok) return { ok: true, jobId };
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (response.status === 409 && body?.error === "not-uploading") return { ok: true, jobId };
    if (response.status === 409 && body?.error === "upload-failed") {
      return { ok: false, message: MESSAGES.uploadTimedOut };
    }
    if (response.status === 404) return failed(MESSAGES.notFound);
    if (response.status === 409 && body?.error === "missing") return "missing";
    if (response.status === 409) return failed(MESSAGES.notArrived);
    return failed(sessionMessage(response.status) ?? MESSAGES.notArrived);
  }
  return { ok: false, message: MESSAGES.confirmLost };
}
