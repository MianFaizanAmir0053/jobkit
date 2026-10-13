import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

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
import { jobView } from "./jobView";

/**
 * Recording the owner's decisions on a ready kit (review spec, "The
 * outbound gate"): one decision at a time, checked against what the kit
 * holds, kept in the job's kit_reviews row with the gate's open reasons as
 * they now stand. The row is locked while a decision is applied, so two
 * decisions made at once are both kept.
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
      return parts.contact !== null;
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
    const gate = canHandOff(gateInputOf(parts, decisions));
    await tx.query(
      `update {{schema}}.kit_reviews set decisions = $3::jsonb, gate = $4::jsonb, updated_at = $5
        where job_id = $1 and role_id = $2`,
      [jobId, roleId, JSON.stringify(decisions), JSON.stringify(gate), now],
    );
    return { ok: true as const, decisions, gate };
  });
}
