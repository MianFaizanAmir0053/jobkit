import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { confirmUploads, startJob } from "@/core/intake/jobs";
import { CONTENT_TYPES } from "@/core/intake/limits";
import type { RunnerDeps } from "@/core/platform/runner";
import type { Storage } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { NO_STORE, refusal, sessionForChange } from "@/server/http";
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
  clientElapsedMs: z.number().nonnegative(),
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
  const started = await startJob(deps, body.data);
  if (!started.ok) return refusal(422, started.message);
  if (started.queued) await startPipeline(deps, started.jobId, startedAt);
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
  const confirmed = await confirmUploads(deps, jobId);
  if (!confirmed.ok) {
    if (confirmed.reason === "not-found") return refusal(404, "not-found");
    if (confirmed.reason === "missing") {
      return refusal(409, "missing", { missing: confirmed.missing });
    }
    return refusal(409, confirmed.reason);
  }
  await startPipeline(deps, jobId, startedAt);
  return NextResponse.json({ queued: true }, { status: 202, headers: NO_STORE });
}

/** The body as JSON, null when it is not JSON, or "too-large" past 64 KB, declared or sent. */
async function smallJson(request: NextRequest): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return "too-large";
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return "too-large";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
