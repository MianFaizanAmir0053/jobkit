import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  type AgainResult,
  confirmUploads,
  reissueUploads,
  startJob,
  uploadAgain,
} from "@/core/intake/jobs";
import { CONTENT_TYPES, LIMITS } from "@/core/intake/limits";
import type { RunnerDeps } from "@/core/platform/runner";
import type { Random, Storage } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { NO_STORE, readLimited, refusal, sessionForChange } from "@/server/http";
import { startPipeline } from "@/server/jobs";

/**
 * Intake's routes (intake spec, "Upload path"). Only metadata reaches them:
 * the phone uploads image bytes straight to storage through the URLs these
 * hand back, so a body over 64 KB is refused as one that could only be
 * image bytes. Creating a job, uploading a failed one again, asking for
 * fresh upload URLs and confirming one need an approved session.
 */

type Deps = RunnerDeps & {
  storage: Storage;
  /** Draws a new job's timing arm during real use (ledger spec); the app's container gives it. */
  random?: Random;
  config: AppConfig;
  /** Next's after() in the app: the pipeline runs once the response has gone. */
  schedule: (task: () => Promise<unknown>) => void;
};

const MAX_BODY_BYTES = 64 * 1024;

const newJobBody = z.object({
  images: z.array(
    z.object({
      contentType: z.enum(CONTENT_TYPES),
      bytes: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  pastedText: z.string().default(""),
  clientElapsedMs: z.number().int().nonnegative(),
  /** Where the job came from (intake spec, "Upload path", step 2). */
  inputKind: z.enum(["page", "share"]).default("page"),
  /** A share's url field, kept as a reference and never fetched; one past a link's length is not kept. */
  sharedUrl: z.string().default(""),
});

/** POST /api/jobs: creates the job and hands back an upload URL per image; a paste-only job starts at once. */
export async function create(
  request: NextRequest,
  deps: Deps,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const json = await smallJson(request);
  if (json === "too-large") return refusal(413, "too-large");
  const body = newJobBody.safeParse(json);
  if (!body.success) return refusal(400, "invalid");
  // The job was received when its request reached the route (intake spec, "Clock").
  const started = await startJob(deps, body.data, startedAt);
  if (!started.ok) return refusal(422, started.message);
  // The job exists now: a pipeline that fails to start is started by the job page's next poll.
  if (started.queued) await startPipeline(deps, started.jobId, startedAt).catch(() => false);
  return NextResponse.json(
    {
      jobId: started.jobId,
      uploads: started.uploads,
      queued: started.queued,
      ...(started.manual ? { manual: true } : {}),
    },
    { status: 201, headers: NO_STORE },
  );
}

const againBody = z.object({ images: newJobBody.shape.images });

/**
 * POST /api/jobs/<id>/upload-again: "Upload again" on a job whose upload
 * failed (intake spec, "Upload path", step 5). The screenshots chosen again
 * replace the job's own, and one upload URL for each comes back, as for a
 * new job; the page then uploads and confirms them as it does a new job's.
 */
export async function again(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const json = await smallJson(request);
  if (json === "too-large") return refusal(413, "too-large");
  const body = againBody.safeParse(json);
  if (!body.success) return refusal(400, "invalid");
  let uploaded: AgainResult;
  try {
    // What arrived of the failed upload is removed once the answer has gone.
    uploaded = await uploadAgain(deps, jobId, body.data.images, deps.schedule);
  } catch {
    // Storage could not give a URL, or the database the job; nothing changed, and the page asks again.
    return refusal(503, "storage-unavailable");
  }
  if (!uploaded.ok) {
    if ("message" in uploaded) return refusal(422, uploaded.message);
    return refusal(uploaded.reason === "not-found" ? 404 : 409, uploaded.reason);
  }
  return NextResponse.json(
    { jobId: uploaded.jobId, uploads: uploaded.uploads },
    { status: 200, headers: NO_STORE },
  );
}

/** POST /api/jobs/<id>/uploaded: queues the job once every image arrived, and starts the pipeline. */
export async function confirm(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const carried = await carriedIn(request);
  if (carried === "too-large") return refusal(413, "too-large");
  if (carried === "invalid") return refusal(400, "invalid");
  let confirmed: Awaited<ReturnType<typeof confirmUploads>>;
  try {
    confirmed = await confirmUploads(deps, jobId, carried);
  } catch {
    // Storage could not say what arrived; the page asks again.
    return refusal(503, "storage-unavailable");
  }
  if (!confirmed.ok) {
    if (confirmed.reason === "not-found") return refusal(404, "not-found");
    if (confirmed.reason === "missing") {
      return refusal(409, "missing", { missing: confirmed.missing });
    }
    // "not-uploading" is a job confirmed already; "upload-failed" one that ran out of time.
    return refusal(409, confirmed.reason);
  }
  // Queued now: a pipeline that fails to start is started by the job page's next poll.
  await startPipeline(deps, jobId, startedAt).catch(() => false);
  return NextResponse.json({ queued: true }, { status: 202, headers: NO_STORE });
}

/**
 * POST /api/jobs/<id>/upload-urls: fresh upload URLs for the screenshots
 * not yet stored, after the page reloaded or the connection dropped
 * (intake spec, "Upload path", step 3).
 */
export async function reissue(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const carried = await carriedIn(request);
  if (carried === "too-large") return refusal(413, "too-large");
  if (carried === "invalid") return refusal(400, "invalid");
  let reissued: Awaited<ReturnType<typeof reissueUploads>>;
  try {
    reissued = await reissueUploads(deps, jobId, carried);
  } catch {
    // Storage could not say what arrived, or give a URL; the page asks again.
    return refusal(503, "storage-unavailable");
  }
  if (!reissued.ok) return refusal(reissued.reason === "not-found" ? 404 : 409, reissued.reason);
  return NextResponse.json({ uploads: reissued.uploads }, { status: 200, headers: NO_STORE });
}

const carriedBody = z.object({ imageIds: z.array(z.uuid()).max(LIMITS.images) });

/**
 * The screenshots a page carries, which it names as it asks for fresh URLs
 * or confirms, so a page whose upload was begun again since is told so;
 * none from a page from before pages named them, which sends nothing.
 */
async function carriedIn(
  request: NextRequest,
): Promise<readonly string[] | undefined | "too-large" | "invalid"> {
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return "too-large";
  const text = new TextDecoder().decode(body).trim();
  if (text === "") return undefined;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    return "invalid";
  }
  const parsed = carriedBody.safeParse(json);
  return parsed.success ? parsed.data.imageIds : "invalid";
}

/** The body as JSON, null when it is not JSON, or "too-large" past 64 KB, declared or sent. */
async function smallJson(request: NextRequest): Promise<unknown> {
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return "too-large";
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}
