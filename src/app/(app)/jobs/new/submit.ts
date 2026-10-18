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
 * after a reload (step 3). Every message that ends a kept upload says to
 * press Start again, and every one that keeps it says jobkit goes on. The
 * job's clock starts at the tap: Start calls this at once, and it reads the
 * time before anything else. The browser's pieces come in as deps, so the
 * flow is tested without a browser.
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
  get(jobId: string): Promise<PendingUpload | null>;
  clear(jobId: string): Promise<void>;
  /** Forgets every kept upload whose deadline is at or before this one. */
  clearUpTo(deadlineAt: number): Promise<void>;
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
  /**
   * Runs `run` while holding the named lock across the browser's tabs, or
   * gives null at once when another run holds it (the Web Locks API).
   */
  exclusive: <T>(name: string, run: () => Promise<T>) => Promise<T | null>;
}

/** The lock one job's upload runs under, so no two tabs send its files at once. */
const uploadLock = (jobId: string) => `jobkit-upload-${jobId}`;

export type Submitted = { ok: true; jobId: string } | { ok: false; message: string };

export const MESSAGES = {
  notStarted: "The job could not start. Try again.",
  createLost:
    "The connection dropped while the job was starting. Check the Jobs list before you press Start again: the job may have started.",
  confirmLost:
    "The upload could not be checked, and the job may have started. Open New job again within 15 minutes of the start and jobkit checks it; the Jobs list shows it too.",
  checkJobs: "Then check the Jobs list before you press Start again: the job may have started.",
  signIn: "You are signed out. Sign in again, then press Start.",
  signInToFinish:
    "You are signed out. Sign in again and open New job within 15 minutes of the start: jobkit finishes the upload then.",
  notAllowed:
    "This device cannot start jobs. Approve it on the laptop's Devices page, or sign in again.",
  notAllowedToFinish:
    "This device is not approved. Approve it on the laptop's Devices page, or sign in again, and open New job within 15 minutes of the start: jobkit finishes the upload then.",
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
  notFailed:
    "This job is not waiting for its screenshots any more: open it from the Jobs list to see how it stands.",
  begunAgain:
    "This job's upload was started again, on another device or in another tab: open the job to follow it.",
  againLost:
    "The connection dropped as the upload began again. Press Start again: the upload starts over.",
  uploadingElsewhere:
    "Another tab of this browser is uploading this job's screenshots. Open the job there, or close that tab and press Start again.",
  notResumed:
    "The upload could not finish yet. Check the connection and open New job again within 15 minutes of the start: jobkit tries again then.",
  unkept:
    "The upload did not finish, and this browser could not keep it to try again. Check the Jobs list before you press Start again: the job may have started.",
  wentWrong: "Something went wrong. Check the connection and press Start again.",
} as const;

/** The messages that keep an upload for New job to finish; the form then lets it go. */
const KEEPING = [
  MESSAGES.confirmLost,
  MESSAGES.notResumed,
  MESSAGES.signInToFinish,
  MESSAGES.notAllowedToFinish,
];

/**
 * The messages that end a kept upload: nothing more can come of it, or the
 * page says to press Start again, which a later visit must not undo by
 * finishing the old job.
 */
const ENDING = [
  MESSAGES.uploadTimedOut,
  MESSAGES.begunAgain,
  MESSAGES.notFound,
  MESSAGES.refusedUpload,
  MESSAGES.notStarted,
  MESSAGES.notArrived,
  MESSAGES.tooSlow,
  MESSAGES.wentWrong,
];

// A message may carry the advice to check the Jobs list after it.
const among = (messages: readonly string[], outcome: Submitted) =>
  !outcome.ok && messages.some((message) => outcome.message.startsWith(message));

/**
 * Whether an outcome keeps the upload for New job to finish: the form then
 * holds nothing to start again, since a second start would make the same
 * job twice.
 */
export function keepsUpload(outcome: Submitted): boolean {
  return among(KEEPING, outcome);
}

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
 * A kept upload a minute past the server's 15 minutes is forgotten without
 * asking: the server settled it, and the Jobs list says how, while asking
 * would keep New job waiting on a job the owner may no longer think of.
 */
export const FORGET_AFTER_DEADLINE_MS = 2 * 60_000;

/**
 * One upload attempt may take half a minute plus the file's size at 16 KB a
 * second, the pace of a slow mobile connection: about five minutes for a
 * 4 MB screenshot.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil(bytes / 16);
}

/**
 * The lock is held until `run` settles, and `ifAvailable` gives null at once
 * when another tab holds it (https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request).
 * Web Locks exist only in secure contexts (HTTPS, or localhost), so a page
 * served over plain HTTP elsewhere runs without one: one tab is the usual case.
 */
async function exclusive<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return run();
  let result: T | null = null;
  await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock) result = await run();
  });
  return result;
}

export const browserDeps: SubmitDeps = {
  prepare: prepareImage,
  // Called through a wrapper: fetch detached from window throws in Chrome.
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
  wallNow: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pending: pendingUploads,
  exclusive,
};

type Uploads = { imageId: string; url: string }[];

/**
 * The page's deadline by both its clocks: the monotonic one survives a change
 * of the phone's time, the wall clock goes on while the phone sleeps.
 */
interface Deadline {
  at: number;
  wallAt: number;
}

function timeLeft(deps: SubmitDeps, deadline: Deadline): number {
  return Math.min(deadline.at - deps.now(), deadline.wallAt - deps.wallNow());
}

export async function submitJob(
  deps: SubmitDeps,
  input: {
    files: readonly File[];
    text: string;
    /** Where the job came from: the New job page, or a share. */
    inputKind?: "page" | "share";
    /** A share's url field, which the job keeps as a link. */
    sharedUrl?: string;
    /** How long a share waited before the page took it, which the job's clock counts. */
    startedAgo?: number;
    /**
     * A job whose upload failed, whose screenshots these replace (intake
     * spec, "Upload path", step 5): it keeps its text, link and start.
     */
    againOf?: string;
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

  onStatus(input.againOf ? "Starting the upload again…" : "Starting the job…");
  const { againOf } = input;
  // Upload again holds its job's upload lock from before its request, so no other tab of this
  // browser starts or finishes that job's upload meanwhile, and none takes it once it has begun.
  if (againOf) {
    const locked = await deps.exclusive(uploadLock(againOf), () => startAndSend(true));
    return locked ?? { ok: false, message: MESSAGES.uploadingElsewhere };
  }
  return startAndSend(false);

  /** Starts the job, or its upload again, and sends its screenshots, under the lock if not held. */
  async function startAndSend(locked: boolean): Promise<Submitted> {
    // An answer lost as the upload begins again: pressing Start again starts it over, safely.
    const lost = againOf ? MESSAGES.againLost : MESSAGES.createLost;
    if (againOf) await deps.pending.clear(againOf).catch(() => undefined);
    // The server's upload clock starts when this request arrives; the page's starts sooner.
    const deadline: Deadline = {
      at: deps.now() + UPLOAD_DEADLINE_MS,
      wallAt: deps.wallNow() + UPLOAD_DEADLINE_MS,
    };
    let created: { jobId: string; uploads: Uploads };
    try {
      const metas = images.map((image) => image.meta);
      const response = await deps.fetch(
        againOf ? `/api/jobs/${againOf}/upload-again` : "/api/jobs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            againOf
              ? { images: metas }
              : {
                  images: metas,
                  pastedText: input.text,
                  inputKind: input.inputKind ?? "page",
                  sharedUrl: input.sharedUrl ?? "",
                  clientElapsedMs: Math.max(
                    0,
                    Math.round(deps.now() - startedAt + (input.startedAgo ?? 0)),
                  ),
                },
          ),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      // A server error may come after the job was created; so may an answer the page cannot read.
      if (response.status >= 500) return { ok: false, message: lost };
      if (!response.ok) return { ok: false, message: await createMessage(response) };
      created = (await response.json()) as typeof created;
      if (!Array.isArray(created.uploads)) throw new Error("no uploads");
    } catch {
      // The server may have created the job, or begun its upload again, before the answer was lost.
      return { ok: false, message: lost };
    }
    if (created.uploads.length !== images.length) {
      return { ok: false, message: MESSAGES.notStarted };
    }
    if (images.length === 0) return { ok: true, jobId: created.jobId };

    const { jobId } = created;
    const blobs = new Map(created.uploads.map((upload, i) => [upload.imageId, images[i]!.blob]));
    const send = async (): Promise<Submitted> => {
      // Kept until the server has it, so a reload can finish it; a browser that cannot keep it
      // still uploads.
      const kept = await deps.pending
        .save({
          jobId,
          deadlineAt: deadline.wallAt,
          images: [...blobs].map(([imageId, blob]) => ({ imageId, blob })),
        })
        .then(
          () => true,
          () => false,
        );
      let outcome: Submitted;
      try {
        const uploaded = await uploadAll(deps, created.uploads, blobs, deadline, onStatus);
        outcome = uploaded
          ? await settled(deps, jobId, await lastWord(deps, jobId, uploaded, [...blobs.keys()]))
          : await finish(deps, jobId, blobs, deadline, onStatus);
      } catch {
        // The page says to press Start again, so no later visit may finish this job.
        return settled(deps, jobId, { ok: false, message: MESSAGES.wentWrong });
      }
      // Nothing kept, nothing for New job to finish: the page must not say it goes on.
      return kept || !keepsUpload(outcome)
        ? outcome
        : { ok: false as const, message: MESSAGES.unkept };
    };
    if (locked) return send();
    const sent = await deps.exclusive(uploadLock(jobId), send);
    return sent ?? { ok: false, message: MESSAGES.notStarted };
  }
}

/**
 * Finishes an upload a reload cut short (intake spec, "Upload path", step 3):
 * fresh URLs for the screenshots the server does not have yet, then the
 * confirmation. Null when no upload waits; "elsewhere" when another tab is
 * finishing it.
 */
export async function resumeUpload(
  deps: SubmitDeps,
  onStatus: (status: string) => void,
  jobId?: string,
): Promise<Submitted | "elsewhere" | null> {
  // The page that uploads one job's screenshots again finishes that job's kept upload alone.
  const pending = await (
    jobId === undefined ? deps.pending.latest() : deps.pending.get(jobId)
  ).catch(() => null);
  if (!pending) return null;
  if (deps.wallNow() > pending.deadlineAt + FORGET_AFTER_DEADLINE_MS) {
    // The newest is the one started last, so every other kept upload is older still; one another
    // tab kept since has a later deadline, and stays.
    await deps.pending.clearUpTo(pending.deadlineAt).catch(() => undefined);
    return null;
  }
  const finished = await deps.exclusive(uploadLock(pending.jobId), async () => {
    // Read again under the lock: a tab that just let go of it may have forgotten the upload.
    const still = await deps.pending.get(pending.jobId).catch(() => null);
    if (!still) return "forgotten" as const;
    return finishKept(deps, still, onStatus).catch(() => ({
      ok: false as const,
      message: MESSAGES.notResumed,
    }));
  });
  // Another tab holds the lock, finishing the upload already: that one carries on.
  if (finished === null) return "elsewhere";
  return finished === "forgotten" ? null : finished;
}

/**
 * Finishes a kept upload. Past the page's deadline nothing more is uploaded,
 * and no fresh URLs are asked for, since each request for them logs an
 * upload attempt: the confirmation alone says how the job stands, and
 * queues it when every file arrived, as when a confirmation's answer was lost.
 */
async function finishKept(
  deps: SubmitDeps,
  pending: PendingUpload,
  onStatus: (status: string) => void,
): Promise<Submitted> {
  onStatus("Finishing the upload of a job started before…");
  const { jobId } = pending;
  const tooSlow: Submitted = { ok: false, message: MESSAGES.tooSlow };
  const carried = pending.images.map((image) => image.imageId);
  const left = pending.deadlineAt - deps.wallNow();
  if (left <= 0) return settled(deps, jobId, await lastWord(deps, jobId, tooSlow, carried));
  const deadline: Deadline = { at: deps.now() + left, wallAt: pending.deadlineAt };
  const fresh = await freshUploads(deps, jobId, deadline, carried);
  if (!Array.isArray(fresh)) {
    return settled(deps, jobId, await lastWord(deps, jobId, fresh, carried));
  }
  const blobs = new Map(pending.images.map((image) => [image.imageId, image.blob]));
  const uploaded = await uploadAll(deps, fresh, blobs, deadline, onStatus);
  if (uploaded) return settled(deps, jobId, await lastWord(deps, jobId, uploaded, carried));
  return finish(deps, jobId, blobs, deadline, onStatus);
}

/**
 * Past the deadline the page uploads nothing more, yet a file whose answer
 * was lost may have arrived: before saying the upload is too slow, it asks
 * for the confirmation, which queues the job when every file did.
 */
async function lastWord(
  deps: SubmitDeps,
  jobId: string,
  outcome: Submitted,
  carried: readonly string[],
): Promise<Submitted> {
  if (outcome.ok || outcome.message !== MESSAGES.tooSlow) return outcome;
  const confirmed = await confirmUpload(deps, jobId, carried);
  return confirmed === "missing" ? outcome : confirmed;
}

/** Uploads each file to its URL in turn; null when every one went, or why the upload stops. */
async function uploadAll(
  deps: SubmitDeps,
  uploads: Uploads,
  blobs: ReadonlyMap<string, Blob>,
  deadline: Deadline,
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
  deadline: Deadline,
  onStatus: (status: string) => void,
): Promise<Submitted> {
  const carried = [...blobs.keys()];
  for (let round = 0; ; round++) {
    onStatus("Checking the upload…");
    const confirmed = await confirmUpload(deps, jobId, carried);
    if (confirmed !== "missing") return settled(deps, jobId, confirmed);
    if (round === RESUME_ROUNDS)
      return settled(deps, jobId, { ok: false, message: MESSAGES.notArrived });
    // The confirmation just said what is missing, so a deadline past here needs no other.
    const fresh = await freshUploads(deps, jobId, deadline, carried);
    if (!Array.isArray(fresh)) return settled(deps, jobId, fresh);
    const uploaded = await uploadAll(deps, fresh, blobs, deadline, onStatus);
    if (uploaded) return settled(deps, jobId, await lastWord(deps, jobId, uploaded, carried));
  }
}

/**
 * Forgets a kept upload once the outcome ends it; one cut short by the
 * connection or the session is kept to try again.
 */
async function settled(deps: SubmitDeps, jobId: string, outcome: Submitted): Promise<Submitted> {
  if (outcome.ok || among(ENDING, outcome)) {
    await deps.pending.clear(jobId).catch(() => undefined);
  }
  return outcome;
}

/**
 * Fresh URLs for the screenshots the server does not have yet, or what the
 * page should say: a job the server took already opens, one past its time
 * or gone says so, and anything else keeps the upload to try again.
 */
async function freshUploads(
  deps: SubmitDeps,
  jobId: string,
  deadline: Deadline,
  /** The screenshots the page carries, which the server checks are still the job's. */
  carried: readonly string[],
): Promise<Uploads | Submitted> {
  // Asked again while the connection or the server fails, three times at most, and never past
  // the deadline: each request logs an upload attempt, and none could run.
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await deps.wait(BACKOFF_MS[attempt - 1]!);
    if (timeLeft(deps, deadline) <= 0) return { ok: false, message: MESSAGES.tooSlow };
    try {
      response = await deps.fetch(`/api/jobs/${jobId}/upload-urls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageIds: carried }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      response = null;
      continue;
    }
    if (!busy(response.status)) break;
  }
  if (!response || busy(response.status)) return { ok: false, message: MESSAGES.notResumed };
  const body = (await response.json().catch(() => null)) as {
    uploads?: unknown;
    error?: unknown;
  } | null;
  if (response.ok && Array.isArray(body?.uploads)) return body.uploads as Uploads;
  if (response.status === 409 && body?.error === "not-uploading") return { ok: true, jobId };
  if (response.status === 409 && body?.error === "upload-failed") {
    return { ok: false, message: MESSAGES.uploadTimedOut };
  }
  if (response.status === 409 && body?.error === "begun-again") {
    return { ok: false, message: MESSAGES.begunAgain };
  }
  if (response.status === 404) return { ok: false, message: MESSAGES.notFound };
  return { ok: false, message: keptSessionMessage(response.status) ?? MESSAGES.notResumed };
}

/** The server's own words for a job it refused; otherwise what the owner can do about it. */
async function createMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (response.status === 422 && typeof body?.error === "string") return body.error;
  if (response.status === 413) return MESSAGES.tooLarge;
  // Only Upload again answers so: the job's upload began again elsewhere, or it moved on.
  if (response.status === 409) return MESSAGES.notFailed;
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

/** The same, once the job exists: its upload is kept, and New job finishes it later. */
function keptSessionMessage(status: number): string | null {
  if (status === 401) return MESSAGES.signInToFinish;
  if (status === 403) return MESSAGES.notAllowedToFinish;
  return null;
}

/** An answer to ask again after, as after a dropped connection: the server or a proxy is busy. */
function busy(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
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
  deadline: Deadline,
): Promise<"done" | "refused" | "too-slow"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await deps.wait(BACKOFF_MS[attempt - 1]!);
    const left = timeLeft(deps, deadline);
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
 * connection, the server or a proxy fails. A job that the server finds
 * already queued or running was confirmed by an attempt whose answer was
 * lost. Any dropped connection, timeout or server error may have come after
 * the job was queued, so from then on a refusal that forgets the upload says
 * to check the Jobs list; one that keeps it says New job checks again.
 */
async function confirmUpload(
  deps: SubmitDeps,
  jobId: string,
  /** The screenshots the page carries, which the server checks are still the job's. */
  carried: readonly string[],
): Promise<Submitted | "missing"> {
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageIds: carried }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      uncertain = true;
      continue;
    }
    if (busy(response.status)) {
      uncertain = true;
      continue;
    }
    if (response.ok) return { ok: true, jobId };
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (response.status === 409 && body?.error === "not-uploading") return { ok: true, jobId };
    if (response.status === 409 && body?.error === "upload-failed") {
      return { ok: false, message: MESSAGES.uploadTimedOut };
    }
    if (response.status === 409 && body?.error === "begun-again") {
      return { ok: false, message: MESSAGES.begunAgain };
    }
    if (response.status === 404) return failed(MESSAGES.notFound);
    if (response.status === 409 && body?.error === "missing") return "missing";
    if (response.status === 409) return failed(MESSAGES.notArrived);
    // Kept: once the session is back, New job asks the server how the job stands.
    const kept = keptSessionMessage(response.status);
    if (kept) return { ok: false, message: kept };
    // Any other answer says nothing of what arrived: kept, and checked again on the next visit.
    return { ok: false, message: MESSAGES.confirmLost };
  }
  return { ok: false, message: MESSAGES.confirmLost };
}
