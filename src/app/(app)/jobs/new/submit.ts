import { refusal } from "@/core/intake/limits";

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
  signIn: "You are signed out. Sign in again, then press Start.",
  notAllowed:
    "This device cannot start jobs. Approve it on the laptop's Devices page, or sign in again.",
  badRequest:
    "The page sent something the server did not expect. Reload the page and press Start again.",
  notArrived: "Some screenshots did not arrive. Check the connection and press Start again.",
  notFound: "The job could not be found. Press Start again.",
} as const;

/** Waits before the second and third attempt of a request. */
export const BACKOFF_MS = [1_000, 3_000] as const;

/** One upload attempt may take this long: a 10 MB screenshot on a slow mobile connection. */
export const UPLOAD_TIMEOUT_MS = 120_000;

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
  let response: Response;
  try {
    response = await deps.fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: images.map((image) => image.meta),
        pastedText: input.text,
        clientElapsedMs: Math.max(0, Math.round(deps.now() - startedAt)),
      }),
    });
  } catch {
    // The server may have created the job before the answer was lost.
    return { ok: false, message: MESSAGES.createLost };
  }
  if (!response.ok) return { ok: false, message: await createMessage(response) };
  const created = (await response.json()) as {
    jobId: string;
    uploads: { imageId: string; url: string }[];
  };
  if (created.uploads.length !== images.length) return { ok: false, message: MESSAGES.notStarted };

  for (const [i, upload] of created.uploads.entries()) {
    onStatus(`Uploading screenshot ${i + 1} of ${created.uploads.length}…`);
    await uploadFile(deps, upload.url, images[i]!.blob);
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
 * Up to three attempts per file, waiting longer before each. Only a dropped
 * connection, a timeout or a server error is tried again: any other answer is
 * final, because a signed URL takes one upload, and the confirm step then
 * checks what arrived.
 */
async function uploadFile(deps: SubmitDeps, url: string, blob: Blob): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await deps.wait(BACKOFF_MS[attempt - 1]!);
    try {
      const response = await deps.fetch(url, {
        method: "PUT",
        body: blob,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (response.status < 500) return;
    } catch {
      // A dropped connection or a timeout; try again.
    }
  }
}

/**
 * Asks the server to confirm the upload, up to three times while the
 * connection or the server fails. A job no longer uploading was confirmed
 * already, by an answer that was lost, or timed out: either way the job page
 * shows where it stands.
 */
async function confirmUpload(deps: SubmitDeps, jobId: string): Promise<Submitted> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await deps.wait(BACKOFF_MS[attempt - 1]!);
    let response: Response;
    try {
      response = await deps.fetch(`/api/jobs/${jobId}/uploaded`, { method: "POST" });
    } catch {
      continue;
    }
    if (response.status >= 500) continue;
    if (response.ok) return { ok: true, jobId };
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (response.status === 409 && body?.error === "not-uploading") return { ok: true, jobId };
    if (response.status === 404) return { ok: false, message: MESSAGES.notFound };
    return { ok: false, message: sessionMessage(response.status) ?? MESSAGES.notArrived };
  }
  return { ok: false, message: MESSAGES.notArrived };
}
