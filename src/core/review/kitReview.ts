import { applyAgain } from "@/core/ledger/duplicates";
import { setAddress } from "@/core/ledger/statuses";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, contactForLedger } from "./applications";
import { canHandOff, type GateReason } from "./canHandOff";
import {
  decide,
  decisionsSchema,
  gateInputOf,
  type KitParts,
  NO_DECISIONS,
  type ReviewAction,
  type ReviewDecisions,
} from "./decisions";
import { duplicateParts, duplicatesOf, jobView } from "./jobView";

/**
 * Recording the owner's decisions on a ready kit (review spec, "The
 * outbound gate"): one decision at a time, checked against what the kit
 * holds, kept in the job's kit_reviews row with the gate's open reasons as
 * they now stand. The row is locked while a decision is applied, so two
 * decisions made at once are both kept. A contact the owner types that
 * passes its check becomes the application's, so the duplicate check runs
 * on it (ledger spec, "Duplicate check"). "Apply again" goes to the ledger,
 * which keeps it on the application, and the gate is kept again after it.
 */

export type ReviewOutcome =
  | { ok: true; decisions: ReviewDecisions; gate: GateReason[] }
  | { ok: false; reason: "not-found" | "not-ready" | "not-in-kit" };

/** Whether the kit has a place for the decision. */
function fits(action: ReviewAction, parts: KitParts): boolean {
  switch (action.kind) {
    case "check":
    case "uncheck":
      return parts.blocks.includes(action.blockId);
    case "retype":
      return parts.contact?.needsRetype === true;
    case "attach":
      return parts.attachments.includes(action.name);
    case "continue_anyway":
      return parts.scamSignals.length > 0;
  }
}

export async function recordReview(
  deps: { db: Db; clock: Clock },
  jobId: string,
  action: ReviewAction,
): Promise<ReviewOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const view = await jobView(deps, jobId);
  if (!view) return { ok: false, reason: "not-found" };
  if (view.state !== "kit_ready" || !view.kitParts || !view.role) {
    return { ok: false, reason: "not-ready" };
  }
  const parts = view.kitParts;
  if (!fits(action, parts)) return { ok: false, reason: "not-in-kit" };
  const roleId = view.role.id;
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    await tx.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, $2, $3::jsonb, '[]'::jsonb, $4) on conflict (job_id, role_id) do nothing`,
      [jobId, roleId, JSON.stringify(NO_DECISIONS), now],
    );
    const { rows } = await tx.query<{ decisions: unknown }>(
      `select decisions from {{schema}}.kit_reviews
        where job_id = $1 and role_id = $2 for update`,
      [jobId, roleId],
    );
    const kept = decisionsSchema.safeParse(rows[0]?.decisions);
    const decisions = decide(kept.success ? kept.data : NO_DECISIONS, action);
    // Under the row's lock, so two retypes at once leave the ledger with the one kept here.
    let kit = parts;
    const typed = action.kind === "retype" && contactForLedger(parts.contact!.kind, action.value);
    const applicationId = typed ? await applicationIdOf(tx, jobId, roleId) : null;
    if (typed && applicationId) {
      await setAddress({ db: tx }, applicationId, typed);
      kit = { ...parts, duplicates: duplicateParts(await duplicatesOf(tx, applicationId)) };
    }
    const gate = canHandOff(gateInputOf(kit, decisions));
    await tx.query(
      `update {{schema}}.kit_reviews set decisions = $3::jsonb, gate = $4::jsonb, updated_at = $5
        where job_id = $1 and role_id = $2`,
      [jobId, roleId, JSON.stringify(decisions), JSON.stringify(gate), now],
    );
    return { ok: true as const, decisions, gate };
  });
}

/**
 * "Apply again" on the duplicate banner: covers the matches the banner
 * showed, and no others (ledger spec, "Duplicates"), then keeps the gate
 * as it now stands.
 */
export async function applyAgainForJob(
  deps: { db: Db; clock: Clock },
  jobId: string,
  keys: readonly string[],
): Promise<ReviewOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const view = await jobView(deps, jobId);
  if (!view) return { ok: false, reason: "not-found" };
  if (view.state !== "kit_ready" || !view.role) return { ok: false, reason: "not-ready" };
  const shown = new Set(view.duplicates.map((match) => match.key));
  if (keys.length === 0 || !keys.every((key) => shown.has(key))) {
    return { ok: false, reason: "not-in-kit" };
  }
  const applicationId = await applicationIdOf(deps.db, jobId, view.role.id);
  if (!applicationId) return { ok: false, reason: "not-ready" };
  await applyAgain(deps, applicationId, keys);
  const now = await jobView(deps, jobId);
  if (!now?.review || !now.role) return { ok: false, reason: "not-ready" };
  await deps.db.query(
    `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5)
     on conflict (job_id, role_id) do update set gate = excluded.gate, updated_at = excluded.updated_at`,
    [
      jobId,
      now.role.id,
      JSON.stringify(now.review.decisions),
      JSON.stringify(now.review.gate),
      deps.clock.now(),
    ],
  );
  return { ok: true, decisions: now.review.decisions, gate: now.review.gate };
}
