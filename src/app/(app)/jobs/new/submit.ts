import { refusal } from "@/core/intake/limits";
import { UPLOAD_TIMEOUT_MS } from "@/core/platform/jobs";

import { type Prepared, type PreparedImage, prepareImage } from "./prepare";

/**
 * What Start does (intake spec, "Upload path"): prepare each screenshot,
 * refuse what breaks intake's limits with the server's own words, create the
 * job with metadata only, upload each file straight to its URL, and ask the
 * server to confirm the files arrived. The job's clock starts at the tap:
 * Start calls this at once, and it reads the time before anything else. The
 * browser's pieces come in as deps, so the flow is tested without a browser.
 */

export interface SubmitDeps {
  prepare: (file: File) => Promise<Prepared>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Monotonic milliseconds. */
  now: () => number;
  wait: (ms: number) => Promise<void>;
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
} as const;

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
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function submitJob(
  deps: SubmitDeps,
  input: { files: readonly File[]; text: string },
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
  let created: { jobId: string; uploads: { imageId: string; url: string }[] };
  try {
    const response = await deps.fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: images.map((image) => image.meta),
        pastedText: input.text,
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

  for (const [i, upload] of created.uploads.entries()) {
    onStatus(`Uploading screenshot ${i + 1} of ${created.uploads.length}…`);
    const uploaded = await uploadFile(deps, upload.url, images[i]!.blob, deadline);
    if (uploaded === "too-slow") return { ok: false, message: MESSAGES.tooSlow };
    if (uploaded === "refused") return { ok: false, message: MESSAGES.refusedUpload };
  }
  if (images.length > 0) {
    onStatus("Checking the upload…");
    const confirmed = await confirmUpload(deps, created.jobId);
    if (!confirmed.ok) return confirmed;
  }
  return { ok: true, jobId: created.jobId };
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
async function confirmUpload(deps: SubmitDeps, jobId: string): Promise<Submitted> {
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
    if (response.status === 409) return failed(MESSAGES.notArrived);
    return failed(sessionMessage(response.status) ?? MESSAGES.notArrived);
  }
  return { ok: false, message: MESSAGES.confirmLost };
}
