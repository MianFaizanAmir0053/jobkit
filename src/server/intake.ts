import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { confirmUploads, startJob } from "@/core/intake/jobs";
import { CONTENT_TYPES } from "@/core/intake/limits";
import type { RunnerDeps } from "@/core/platform/runner";
import type { Storage } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { NO_STORE, readLimited, refusal, sessionForChange } from "@/server/http";
import { startPipeline } from "@/server/jobs";

/**
 * Intake's routes (intake spec, "Upload path"). Only metadata reaches them:
 * the phone uploads image bytes straight to storage through the URLs these
 * hand back, so a body over 64 KB is refused as one that could only be
 * image bytes. Creating or confirming a job needs an approved session.
 */

type Deps = RunnerDeps & {
  storage: Storage;
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
    { jobId: started.jobId, uploads: started.uploads, queued: started.queued },
    { status: 201, headers: NO_STORE },
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
  if ((await readLimited(request, MAX_BODY_BYTES)) === "too-large") {
    return refusal(413, "too-large");
  }
  let confirmed: Awaited<ReturnType<typeof confirmUploads>>;
  try {
    confirmed = await confirmUploads(deps, jobId);
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
