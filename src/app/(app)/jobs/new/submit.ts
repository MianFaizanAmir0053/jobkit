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
}

export type Submitted = { ok: true; jobId: string } | { ok: false; message: string };

export const MESSAGES = {
  notStarted: "The job could not start. Try again.",
  notArrived: "Some screenshots did not arrive. Check the connection and press Start again.",
} as const;

export const browserDeps: SubmitDeps = {
  prepare: prepareImage,
  // Called through a wrapper: fetch detached from window throws in Chrome.
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
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
  const response = await deps.fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      images: images.map((image) => image.meta),
      pastedText: input.text,
      clientElapsedMs: Math.max(0, Math.round(deps.now() - startedAt)),
    }),
  });
  if (!response.ok) return { ok: false, message: await messageOf(response) };
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
    const confirmed = await deps.fetch(`/api/jobs/${created.jobId}/uploaded`, { method: "POST" });
    if (!confirmed.ok) return { ok: false, message: MESSAGES.notArrived };
  }
  return { ok: true, jobId: created.jobId };
}

/** The server's own words for a job it refused, or a general message. */
async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return response.status === 422 && typeof body?.error === "string"
    ? body.error
    : MESSAGES.notStarted;
}

/**
 * Up to three attempts per file. Only a dropped connection or a server error
 * is tried again: any other answer is final, because a signed URL takes one
 * upload, and the confirm step then checks what arrived.
 */
async function uploadFile(deps: SubmitDeps, url: string, blob: Blob): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await deps.fetch(url, { method: "PUT", body: blob });
      if (response.status < 500) return;
    } catch {
      // A dropped connection; try again.
    }
  }
}
