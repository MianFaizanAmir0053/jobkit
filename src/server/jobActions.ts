import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { confirmPost, draftAnyway as draftAnywayCore, pickRole } from "@/core/extraction/owner";
import { jobStatus, retryJob } from "@/core/platform/jobs";
import { JOB_STATES } from "@/core/platform/jobStates";
import type { RunnerDeps } from "@/core/platform/runner";
import type { Dns, Storage } from "@/core/ports";
import { openForJob } from "@/core/review/applications";
import { reviewActionSchema } from "@/core/review/decisions";
import {
  backToDrafts as backToDraftsCore,
  draftWithGemini,
  pickDraft,
} from "@/core/review/draftChoice";
import { jobView } from "@/core/review/jobView";
import { applyAgainForJob, recordReview } from "@/core/review/kitReview";
import { markBounced, takeBackBounced } from "@/core/review/markBounced";
import { markSubmitted, takeBackSubmitted } from "@/core/review/markSubmitted";
import { markSent, recordHandoff, takeBackSent } from "@/core/review/markSent";
import { postImages } from "@/core/review/postImages";
import { closeSkipped, skipKit, takeBackSkip } from "@/core/review/skipKit";
import { keepForEvaluation } from "@/core/intake/keepForEval";
import { isUuid } from "@/lib/uuid";
import type { AppConfig } from "@/server/config";
import { NO_STORE, readLimited, refusal, sessionForChange, sessionForRead } from "@/server/http";
import { startPipeline } from "@/server/jobs";

/**
 * The owner's answers on the job page (platform spec B9; extraction and
 * review specs): Retry, Skip, the role pick, "This is a job post" or "Read
 * it again", Draft anyway, a decision on the kit, the pick of a draft, a
 * Gemini draft beside the templates' and the way back from one that failed
 * (decisions A22), and Mark sent. Each needs an approved session and the
 * app's own origin, moves the job only from the state it was read in, and,
 * where the job runs again, starts the pipeline as the upload confirmation
 * does.
 */

type Deps = RunnerDeps & {
  config: AppConfig;
  /** The address checks' DNS, for an address the owner types. */
  dns: Dns;
  /** Next's after() in the app: the pipeline runs once the response has gone. */
  schedule: (task: () => Promise<unknown>) => void;
};

const MAX_BODY_BYTES = 1024;
const REVIEW_BODY_BYTES = 8192;

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

/** The kit the page showed, which every decision names: one made on another kit is refused. */
const kitShown = z.string().min(1).max(100);

/**
 * What the page showed as the owner pressed Skip: on a ready kit, the kit
 * (null when the page could not read one), on any other page the job's
 * state and when the job reached it, and the send it warned may have gone. A Skip that arrives after
 * the job moved on is refused rather than taken for another: a kit's Skip,
 * which can be taken back, never closes a job, and a closing Skip never
 * becomes a kit's. So is one from a page that says neither, from before
 * Skip said what it showed.
 */
const skipBody = z.union([
  z
    .object({ kit: kitShown.nullable(), uncertain: z.uuid().nullable() })
    .transform((shown) => ({ kind: "kit" as const, ...shown })),
  z
    .object({ state: z.enum(JOB_STATES), since: z.iso.datetime(), uncertain: z.uuid().nullable() })
    .transform((shown) => ({ kind: "state" as const, ...shown })),
  z
    .object({})
    .strict()
    .transform(() => ({ kind: "none" as const })),
]);

/**
 * POST /api/jobs/<id>/skip: closes a job waiting on the owner, the role
 * pick's Skip included; on a ready kit, skips its application alone, and
 * the job stays ready, so the skip can be taken back (ledger spec, "Statuses").
 */
export async function skip(request: NextRequest, deps: Deps, jobId: string): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return refusal(413, "too-large");
  const text = new TextDecoder().decode(body).trim();
  let json: unknown = {};
  try {
    // A page from before Skip said what it showed sends nothing.
    if (text !== "") json = JSON.parse(text);
  } catch {
    json = null;
  }
  const parsed = skipBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const shown = parsed.data;
  // As a status read sees it, the upload timeout applied, as the list showing it applied it.
  const job = await jobStatus(deps, jobId);
  if (!job) return refusal(404, "not-found");
  if (shown.kind === "kit") {
    const skippedKit = await skipKit(deps, jobId, actor.session.id, {
      kit: shown.kit,
      uncertain: shown.uncertain,
    });
    if (!skippedKit.ok) {
      return refusal(skippedKit.reason === "not-found" ? 404 : 409, skippedKit.reason);
    }
    return ok();
  }
  // The job closes only as the page showed it, in that state since that time, as the move reads
  // the job again; a page that showed nothing is drawn again.
  if (
    shown.kind === "none" ||
    job.state === "kit_ready" ||
    shown.state !== job.state ||
    new Date(shown.since).getTime() !== job.stateChangedAt.getTime()
  ) {
    return refusal(409, "changed");
  }
  const closed = await closeSkipped(deps, jobId, actor.session.id, {
    state: shown.state,
    since: new Date(shown.since),
    uncertain: shown.uncertain,
  });
  if (!closed.ok) return refusal(closed.reason === "not-found" ? 404 : 409, closed.reason);
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
  // A role is chosen: its application opens with it (ledger spec, "Statuses"), in one transaction.
  const picked = await deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    const chosen = await pickRole(at, jobId, parsed.data.roleId);
    if (chosen.ok) await openForJob(at, jobId, actor.session.id);
    return chosen;
  });
  if (!picked.ok) return refusal(picked.reason === "not-found" ? 404 : 409, picked.reason);
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

/** The email's words as the page showed them (wordsKey). */
const wordsShown = z.string().regex(/^[0-9a-f]{8}$/);

const reviewBody = z.object({
  action: reviewActionSchema,
  kit: kitShown,
  // Optional only so a page from before decisions named it is drawn again, not told it failed.
  words: wordsShown.optional(),
});

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
  // An edited sentence, up to MAX_SENTENCE characters of up to four bytes each, with room.
  const body = await readLimited(request, REVIEW_BODY_BYTES);
  if (body === "too-large") return refusal(413, "too-large");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = reviewBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  if (parsed.data.words === undefined) return refusal(409, "changed");
  const outcome = await recordReview(deps, jobId, parsed.data.action, {
    kit: parsed.data.kit,
    words: parsed.data.words,
    sessionId: actor.session.id,
  });
  if (!outcome.ok) return refusal(outcome.reason === "not-found" ? 404 : 409, outcome.reason);
  // The words the decision left, which the page's next decision names until it is drawn again.
  return ok(200, { gate: outcome.gate, words: outcome.words });
}

/** A small JSON body, parsed with its schema: null when it is too large, not JSON or not of it. */
async function bodyOf<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return { ok: false, response: refusal(413, "too-large") };
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, response: refusal(400, "invalid") };
}

/** A draft of the kit's, as the page names it: Gemini's, or a template's by its ID. */
const pickBody = z.object({
  draft: z
    .string()
    .max(200)
    .regex(/^(gemini|T-[a-z0-9-]+)$/),
  kit: kitShown,
});

/**
 * POST /api/jobs/<id>/pick: the owner picks one of the kit's drafts, which
 * the page then shows and Approve & send sends, answered with the gate as
 * it then stands.
 */
export async function pick(request: NextRequest, deps: Deps, jobId: string): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await bodyOf(request, pickBody);
  if (!body.ok) return body.response;
  const picked = await pickDraft(deps, jobId, body.data.draft, {
    kit: body.data.kit,
    sessionId: actor.session.id,
  });
  if (!picked.ok) return refusal(picked.reason === "not-found" ? 404 : 409, picked.reason);
  return ok(200, { gate: picked.gate });
}

const kitBody = z.object({ kit: kitShown });

/**
 * POST /api/jobs/<id>/draft-with-gemini: on a kit the templates drafted,
 * Gemini writes a draft beside theirs, and the pipeline runs again.
 */
export async function geminiDraft(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await bodyOf(request, kitBody);
  if (!body.ok) return body.response;
  const asked = await draftWithGemini(deps, jobId, {
    kit: body.data.kit,
    sessionId: actor.session.id,
  });
  if (!asked.ok) return refusal(asked.reason === "not-found" ? 404 : 409, asked.reason);
  await startPipeline(deps, jobId, startedAt);
  return ok(202);
}

/**
 * POST /api/jobs/<id>/back-to-drafts: the Gemini draft the owner asked for
 * failed, and the kit is ready again with the templates' drafts.
 */
export async function backToDrafts(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const back = await backToDraftsCore(deps, jobId);
  if (!back.ok) return refusal(back.reason === "not-found" ? 404 : 409, back.reason);
  return ok();
}

/** The keys of the matches the banner showed: every one, however many earlier kits there were. */
const applyAgainBody = z.object({
  keys: z.array(z.string().min(1).max(200)).min(1).max(500),
  kit: kitShown,
});

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
  const body = await readLimited(request, 64 * 1024);
  if (body === "too-large") return refusal(413, "too-large");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = applyAgainBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const outcome = await applyAgainForJob(deps, jobId, parsed.data.keys, {
    kit: parsed.data.kit,
    sessionId: actor.session.id,
  });
  if (!outcome.ok) return refusal(outcome.reason === "not-found" ? 404 : 409, outcome.reason);
  return ok(200, { gate: outcome.gate });
}

/** The Mark sent or the skip the page showed, by its time. */
const takeBackBody = z.union([
  z
    .object({ sentAt: z.iso.datetime() })
    .transform((shown) => ({ kind: "sent" as const, ...shown })),
  z
    .object({ skippedAt: z.iso.datetime() })
    .transform((shown) => ({ kind: "skipped" as const, ...shown })),
  z
    .object({ bouncedAt: z.iso.datetime() })
    .transform((shown) => ({ kind: "bounced" as const, ...shown })),
  z
    .object({ submittedAt: z.iso.datetime() })
    .transform((shown) => ({ kind: "submitted" as const, ...shown })),
]);

/**
 * POST /api/jobs/<id>/take-back: takes back a mistaken Mark sent, or a skip
 * of a ready kit, or a Mark submitted, opening the kit again, or a Mark
 * bounced, the email sent again as it was; each the one the page showed.
 */
export async function takeBack(
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
  const parsed = takeBackBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const shown = parsed.data;
  const taken =
    shown.kind === "sent"
      ? await takeBackSent(deps, jobId, actor.session.id, new Date(shown.sentAt))
      : shown.kind === "skipped"
        ? await takeBackSkip(deps, jobId, actor.session.id, new Date(shown.skippedAt))
        : shown.kind === "submitted"
          ? await takeBackSubmitted(deps, jobId, actor.session.id, new Date(shown.submittedAt))
          : await takeBackBounced(deps, jobId, actor.session.id, new Date(shown.bouncedAt));
  if (!taken.ok) return refusal(taken.reason === "not-found" ? 404 : 409, taken.reason);
  return ok();
}

/**
 * The kit, and the WhatsApp number ("" for none), the page showed as the
 * owner applied; a page drawn before it named the number is refused as
 * changed, not as invalid.
 */
const submittedBody = z.object({ kit: kitShown, to: z.string().max(400).optional() });

/**
 * POST /api/jobs/<id>/submitted: Mark submitted, after the owner sent the
 * application through the post's form, or as a message, with the kit's
 * words; refused for an email kit, and when the page showed another kit or
 * number than the kit now has.
 */
export async function submitted(
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
  const parsed = submittedBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const marked = await markSubmitted(deps, jobId, actor.session.id, {
    kit: parsed.data.kit,
    to: parsed.data.to ?? null,
  });
  if (!marked.ok) return refusal(marked.reason === "not-found" ? 404 : 409, marked.reason);
  return ok(200, { ok: true, changed: marked.changed });
}

/** The Mark sent the page showed, by its time. */
const bouncedBody = z.object({ sentAt: z.iso.datetime() });

const handoffBody = z.object({ kit: kitShown, words: wordsShown });

/**
 * POST /api/jobs/<id>/handoff: the words a handoff from the page (Open in
 * Gmail, a copy button) handed off, posted right after the click, which
 * Mark sent then records; refused for a page that showed another kit or
 * other words (review spec, "The outbound gate").
 */
export async function handoff(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await bodyOf(request, handoffBody);
  if (!body.ok) return body.response;
  const recorded = await recordHandoff(deps, jobId, body.data);
  if (!recorded.ok) return refusal(recorded.reason === "not-found" ? 404 : 409, recorded.reason);
  return ok(200, { ok: true });
}

const keepBody = z.object({ kept: z.boolean() });

/**
 * POST /api/jobs/<id>/keep: "Keep for evaluation", or letting the job go
 * again (evals spec, "Case sources"); refused for a job with no image to
 * keep, as one of pasted text alone.
 */
export async function keepForEval(
  request: NextRequest,
  deps: Deps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await bodyOf(request, keepBody);
  if (!body.ok) return body.response;
  const kept = await keepForEvaluation(deps.db, jobId, body.data.kept);
  if (!kept.ok) return refusal(kept.reason === "not-found" ? 404 : 409, kept.reason);
  return ok(200, { kept: kept.kept });
}

/**
 * POST /api/jobs/<id>/bounced: Mark bounced, on a sent email that came back
 * undelivered, by the Mark sent the page showed; refused for another.
 */
export async function bounced(
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
  const parsed = bouncedBody.safeParse(json);
  if (!parsed.success) return refusal(400, "invalid");
  const marked = await markBounced(deps, jobId, actor.session.id, new Date(parsed.data.sentAt));
  if (!marked.ok) return refusal(marked.reason === "not-found" ? 404 : 409, marked.reason);
  return ok(200, { ok: true, changed: marked.changed });
}

/**
 * GET /api/jobs/<id>/gate: the kit as it stands, whether its gate is open,
 * the address or number it goes to and the status of the role's
 * application, so a page drawn earlier, in another tab or on the other
 * device, opens its outbound controls only while the server agrees on all
 * four, and one drawn before a skip or a bounce, or the taking back of
 * either, is drawn again (review spec, "The outbound gate").
 */
export async function gate(request: NextRequest, deps: Deps, jobId: string): Promise<NextResponse> {
  const actor = await sessionForRead(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const view = await jobView(deps, jobId);
  if (!view) return refusal(404, "not-found");
  return ok(200, {
    kit: view.kitKey,
    open: view.review !== null && view.review.gate.length === 0,
    to: view.handoff?.to ?? null,
    status: view.application?.status ?? null,
    words: view.wordsKey,
  });
}

/**
 * GET /api/jobs/<id>/images: the post's images the job page shows, signed
 * afresh for 60 seconds, for a page one of whose images did not load
 * (review spec, "Contact panel"). The page asks here rather than drawing
 * itself again, which on a failing connection reloads it whole.
 */
export async function images(
  request: NextRequest,
  deps: Deps & { storage: Storage },
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForRead(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const view = await jobView(deps, jobId);
  if (!view) return refusal(404, "not-found");
  return ok(
    200,
    view.images ? await postImages(deps, jobId, view.images) : { crop: null, screenshots: [] },
  );
}

/** The answer to "Did you change anything in Gmail?", and the kit and address the page showed. */
const sentBody = z.object({
  changedInGmail: z.boolean(),
  kit: kitShown,
  to: z.string().max(400),
});

/**
 * POST /api/jobs/<id>/sent: Mark sent, after the owner sent the email from
 * Gmail, with the answer to "Did you change anything in Gmail?"; refused
 * when the page showed another kit or address than the kit now has.
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
  const { changedInGmail, kit, to } = parsed.data;
  const marked = await markSent(deps, jobId, actor.session.id, { changedInGmail }, { kit, to });
  if (!marked.ok) return refusal(marked.reason === "not-found" ? 404 : 409, marked.reason);
  return ok(200, { ok: true, changed: marked.changed });
}
