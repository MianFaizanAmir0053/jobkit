import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  confirmPost,
  draftAnyway as draftAnywayCore,
  pickRole,
  skipRolePick,
} from "@/core/extraction/owner";
import { loadJob, retryJob, skipJob } from "@/core/platform/jobs";
import type { RunnerDeps } from "@/core/platform/runner";
import { openForJob, skippedForJob } from "@/core/review/applications";
import { reviewActionSchema } from "@/core/review/decisions";
import { applyAgainForJob, recordReview } from "@/core/review/kitReview";
import { markSent } from "@/core/review/markSent";
import { isUuid } from "@/lib/uuid";
import type { AppConfig } from "@/server/config";
import { NO_STORE, readLimited, refusal, sessionForChange } from "@/server/http";
import { startPipeline } from "@/server/jobs";

/**
 * The owner's answers on the job page (platform spec B9; extraction and
 * review specs): Retry, Skip, the role pick, "This is a job post" or "Read
 * it again", Draft anyway, a decision on the kit, and Mark sent. Each needs an approved session and the app's
 * own origin, moves the job only from the state it was read in, and, where
 * the job runs again, starts the pipeline as the upload confirmation does.
 */

type Deps = RunnerDeps & {
  config: AppConfig;
  /** Next's after() in the app: the pipeline runs once the response has gone. */
  schedule: (task: () => Promise<unknown>) => void;
};

const MAX_BODY_BYTES = 1024;

const ok = (status = 200, body: object = { ok: true }) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/** POST /api/jobs/<id>/retry: a failed job resumes at the stage that failed. */
export async function retry(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const retried = await retryJob(deps, jobId);
  if (!retried.ok) return refusal(retried.reason === "not-found" ? 404 : 409, retried.reason);
  await startPipeline(deps, jobId, startedAt);
  return ok(202);
}

/** POST /api/jobs/<id>/skip: closes a job waiting on the owner, the role pick's Skip included. */
export async function skip(request: NextRequest, deps: Deps, jobId: string): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const job = await loadJob(deps.db, jobId);
  if (!job) return refusal(404, "not-found");
  const skipped =
    job.state === "needs_role_pick" ? await skipRolePick(deps, jobId) : await skipJob(deps, jobId);
  if (!skipped.ok) return refusal(skipped.reason === "not-found" ? 404 : 409, skipped.reason);
  // Its application, if a role was ever chosen, is skipped with it (ledger spec, "Statuses").
  await skippedForJob(deps, jobId, actor.session.id);
  return ok();
}

const roleBody = z.object({ roleId: z.string().min(1).max(20) });

/** POST /api/jobs/<id>/role: the owner picks one of the post's roles, and the chain goes on with it. */
export async function role(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return refusal(413, "too-large");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = roleBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const picked = await pickRole(deps, jobId, parsed.data.roleId);
  if (!picked.ok) return refusal(picked.reason === "not-found" ? 404 : 409, picked.reason);
  // A role is chosen: its application opens (ledger spec, "Statuses").
  await openForJob(deps, jobId, actor.session.id);
  await startPipeline(deps, jobId, startedAt);
  return ok(202);
}

/** POST /api/jobs/<id>/read-again: "This is a job post", or "Read it again" after no role was found. */
export async function readAgain(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const confirmed = await confirmPost(deps, jobId);
  if (!confirmed.ok) {
    return refusal(confirmed.reason === "not-found" ? 404 : 409, confirmed.reason);
  }
  await startPipeline(deps, jobId, startedAt);
  return ok(202);
}

/** POST /api/jobs/<id>/draft-anyway: the owner drafts for a role that looks closed to them. */
export async function draftAnyway(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const decided = await draftAnywayCore(deps, jobId);
  if (!decided.ok) return refusal(decided.reason === "not-found" ? 404 : 409, decided.reason);
  await startPipeline(deps, jobId, startedAt);
  return ok(202);
}

const reviewBody = z.object({ action: reviewActionSchema });

/**
 * POST /api/jobs/<id>/review: one of the owner's decisions on a ready kit,
 * "I checked this", a typed address or number, an attachment's tick or
 * "Continue anyway", answered with the gate's open reasons as they now stand.
 */
export async function review(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return refusal(413, "too-large");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = reviewBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const outcome = await recordReview(deps, jobId, parsed.data.action);
  if (!outcome.ok) return refusal(outcome.reason === "not-found" ? 404 : 409, outcome.reason);
  return ok(200, { gate: outcome.gate });
}

const applyAgainBody = z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(20) });

/**
 * POST /api/jobs/<id>/apply-again: "Apply again" on the duplicate banner,
 * with the keys of the matches it showed, answered with the gate's open
 * reasons as they now stand.
 */
export async function applyAgainRoute(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await readLimited(request, 8 * 1024);
  if (body === "too-large") return refusal(413, "too-large");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = applyAgainBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const outcome = await applyAgainForJob(deps, jobId, parsed.data.keys);
  if (!outcome.ok) return refusal(outcome.reason === "not-found" ? 404 : 409, outcome.reason);
  return ok(200, { gate: outcome.gate });
}

const sentBody = z.object({ changedInGmail: z.boolean() });

/**
 * POST /api/jobs/<id>/sent: Mark sent, after the owner sent the email from
 * Gmail, with the answer to "Did you change anything in Gmail?".
 */
export async function sent(request: NextRequest, deps: Deps, jobId: string): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return refusal(413, "too-large");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = sentBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const marked = await markSent(deps, jobId, actor.session.id, parsed.data);
  if (!marked.ok) return refusal(marked.reason === "not-found" ? 404 : 409, marked.reason);
  return ok(200, { ok: true, changed: marked.changed });
}
