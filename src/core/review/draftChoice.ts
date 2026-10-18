import { loadJob, moveJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import type { GateReason } from "./canHandOff";
import { NO_DECISIONS, type ReviewDecisions, withFlagNames } from "./decisions";
import { type DraftChecks, draftChecksSchema, jobView } from "./jobView";
import { type DecisionMade, keep, lockedKit } from "./kitReview";

/**
 * The owner's choices among a kit's drafts (decisions A21, with amendment
 * A22). Picking a draft makes it the kit. What the owner marked on its
 * sentences and flags, and their edits of its sentences, count for that
 * draft alone: they are kept aside when
 * they pick another, by the draft's kit key, and comes back when they pick
 * it again. What they decided on the post (a typed address, an attachment's
 * tick, a requirement they say they meet, "Continue anyway") goes with the
 * pick. Asking Gemini for a draft
 * beside the templates' keeps the draft shown, so the kit and the decisions
 * on it stand when Gemini's arrives, and starts a new round of attempts, as
 * Retry does; should it fail, the owner can go back to the templates'
 * drafts. Each is refused when the page showed another kit, while the kit
 * sends, and once it went, under the kit's review row's lock.
 */

async function draftChecksOf(db: Db, jobId: string, roleId: string): Promise<DraftChecks> {
  const { rows } = await db.query<{ draft_checks: unknown }>(
    "select draft_checks from {{schema}}.kit_reviews where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  const parsed = draftChecksSchema.safeParse(rows[0]?.draft_checks);
  return parsed.success ? parsed.data : {};
}

export type PickOutcome =
  | { ok: true; gate: GateReason[] }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "changed" | "sent" | "skipped" | "sending" | "not-in-kit";
    };

/** The owner picks one of the kit's drafts: the one the page shows, and Approve & send sends. */
export async function pickDraft(
  deps: { db: Db; clock: Clock },
  jobId: string,
  draftId: string,
  made: DecisionMade = {},
): Promise<PickOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx): Promise<PickOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, made);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    if (view.kitParts.sending) return { ok: false, reason: "sending" };
    if (!view.drafts.some((draft) => draft.id === draftId)) {
      return { ok: false, reason: "not-in-kit" };
    }
    const roleId = view.role!.id;
    // Kept even when it is the draft shown, so a draft that ranks higher later never replaces it.
    await tx.query(
      `update {{schema}}.kit_reviews set picked_draft = $3, updated_at = $4
        where job_id = $1 and role_id = $2`,
      [jobId, roleId, draftId, deps.clock.now()],
    );
    if (draftId === view.picked) return { ok: true, gate: view.review?.gate ?? [] };
    const picked = await jobView(at, jobId);
    if (!picked?.kitKey) throw new Error(`The draft picked for job ${jobId} made no kit.`);
    const decisions = view.review?.decisions ?? NO_DECISIONS;
    const aside = await draftChecksOf(tx, jobId, roleId);
    // Its flags named as now, though kept by their place among drafting's before flags were named.
    const back = withFlagNames({ ...NO_DECISIONS, ...aside[picked.kitKey] }, picked.draft!.flags);
    const kept: DraftChecks = {
      ...Object.fromEntries(Object.entries(aside).filter(([kit]) => kit !== picked.kitKey)),
      [view.kitKey]: {
        checked: decisions.checked,
        flagsChecked: decisions.flagsChecked,
        edits: decisions.edits,
        confirmed: decisions.confirmed,
      },
    };
    await tx.query(
      `update {{schema}}.kit_reviews set draft_checks = $3::jsonb
        where job_id = $1 and role_id = $2`,
      [jobId, roleId, JSON.stringify(kept)],
    );
    const carried: ReviewDecisions = {
      ...decisions,
      checked: back.checked,
      flagsChecked: back.flagsChecked,
      edits: back.edits,
      confirmed: back.confirmed,
    };
    const outcome = await keep(at, jobId, roleId, picked.kitKey, carried);
    return outcome.ok ? { ok: true, gate: outcome.gate } : outcome;
  });
}

export type GeminiOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "changed" | "sent" | "skipped" | "sending" | "drafted";
    };

/**
 * "Write a draft with Gemini too": on a kit the templates drafted, drafting
 * runs again with `draft`, in a new round of attempts, and the kit is ready
 * again with Gemini's draft among the templates' once the judge has checked
 * it. The draft shown is kept as the owner's pick, so it stays the kit. The
 * caller then starts the pipeline.
 */
export async function draftWithGemini(
  deps: { db: Db; clock: Clock },
  jobId: string,
  made: DecisionMade = {},
): Promise<GeminiOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx): Promise<GeminiOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, made);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    if (view.kitParts.sending) return { ok: false, reason: "sending" };
    if (!view.canDraftWithGemini) return { ok: false, reason: "drafted" };
    const job = await loadJob(tx, jobId);
    const moved =
      job !== null &&
      (await moveJob(tx, jobId, {
        from: "kit_ready",
        to: "drafting",
        pending: "draft",
        at: deps.clock.now(),
        newRound: true,
        ifChangedAt: job.stateChangedAt,
      }));
    if (!moved) return { ok: false, reason: "not-ready" };
    await tx.query(
      "update {{schema}}.kit_reviews set picked_draft = $3 where job_id = $1 and role_id = $2",
      [jobId, view.role!.id, view.picked],
    );
    return { ok: true };
  });
}

/**
 * "Back to your drafts": when the Gemini draft the owner asked for beside
 * the templates' failed, or its check did, or a stage beside it, the kit is
 * ready again with the templates' drafts, instead of Retry or Skip.
 */
export async function backToDrafts(
  deps: { db: Db; clock: Clock },
  jobId: string,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-failed" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  const view = await jobView(deps, jobId);
  if (!view?.canGoBackToDrafts) return { ok: false, reason: "not-failed" };
  const moved = await moveJob(deps.db, jobId, {
    from: "failed",
    to: "kit_ready",
    pending: null,
    at: deps.clock.now(),
    fromPending: job.pendingStage,
    ifChangedAt: job.stateChangedAt,
  });
  return moved ? { ok: true } : { ok: false, reason: "not-failed" };
}
