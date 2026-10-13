import { isStrictAddress } from "@/core/extraction/contacts";
import { chosenRole, currentExtraction } from "@/core/extraction/owner";
import { applyAgain } from "@/core/ledger/duplicates";
import { setAddress } from "@/core/ledger/statuses";
import type { Clock, Db, Dns } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { type AddressCheck, checkAddress } from "./addressChecks";
import { applicationIdOf, contactForLedger, kitReadyForJob } from "./applications";
import type { GateReason } from "./canHandOff";
import {
  decide,
  flagKey,
  type KitParts,
  NO_DECISIONS,
  type ReviewAction,
  type ReviewDecisions,
} from "./decisions";
import { type JobView, jobView, storedDecisions } from "./jobView";

/**
 * Recording the owner's decisions on a ready kit (review spec, "The
 * outbound gate"): one decision at a time, checked against what the kit
 * holds, kept in the job's kit_reviews row for the kit it was made on, with
 * the gate's open reasons as they then stand. The row is locked before the
 * kit is read, so two decisions made at once are both kept, and a decision
 * made as the kit is marked sent finds it sent and is refused. An email
 * address the owner types is checked like the post's (review spec, "Stage
 * address_checks"), and when it passes, it becomes the application's, so
 * the duplicate check runs on it (ledger spec, "Duplicate check"). "Apply
 * again" goes to the ledger, which keeps it on the application, opening one
 * for a kit that ran before applications opened with their jobs.
 */

export type ReviewOutcome =
  | { ok: true; decisions: ReviewDecisions; gate: GateReason[] }
  | { ok: false; reason: "not-found" | "not-ready" | "not-in-kit" | "sent" };

type Refusal = Extract<ReviewOutcome, { ok: false }>;

/** Whether the kit has a place for the decision. */
function fits(action: ReviewAction, parts: KitParts): boolean {
  switch (action.kind) {
    case "check":
    case "uncheck":
      return parts.blocks.includes(action.blockId);
    case "check_flag":
    case "uncheck_flag":
      return parts.flags.some((flag) => flagKey(flag) === action.flag);
    case "retype":
      return parts.contact?.needsRetype === true;
    case "attach":
      return parts.attachments.some((attachment) => attachment.id === action.id);
    case "continue_anyway":
      return parts.scamSignals.length > 0;
  }
}

/**
 * Locks the job's review row, made first if need be, and reads the kit as it
 * then stands: a refusal when there is no ready kit to decide on, or it was
 * marked sent.
 */
async function lockedKit(
  deps: { db: Db; clock: Clock },
  jobId: string,
): Promise<{ view: JobView & { kitParts: KitParts; kitKey: string } } | Refusal> {
  const role = await chosenRole(deps.db, jobId);
  if (role) {
    // A row made here holds no decisions: the kit it names is none.
    await deps.db.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, $2, $3::jsonb, '[]'::jsonb, $4) on conflict (job_id, role_id) do nothing`,
      [jobId, role.id, storedDecisions("", NO_DECISIONS), deps.clock.now()],
    );
    await deps.db.query(
      "select 1 from {{schema}}.kit_reviews where job_id = $1 and role_id = $2 for update",
      [jobId, role.id],
    );
  }
  const view = await jobView(deps, jobId);
  if (!view) return { ok: false, reason: "not-found" };
  const { kitParts, kitKey } = view;
  if (view.state !== "kit_ready" || !view.role || !kitParts || !kitKey) {
    return { ok: false, reason: "not-ready" };
  }
  if (kitParts.sent) return { ok: false, reason: "sent" };
  return { view: { ...view, kitParts, kitKey } };
}

/** Keeps the decisions for the kit, then the gate as the kit now stands with them. */
async function keep(
  deps: { db: Db; clock: Clock },
  jobId: string,
  roleId: string,
  kitKey: string,
  decisions: ReviewDecisions,
): Promise<ReviewOutcome> {
  await deps.db.query(
    `update {{schema}}.kit_reviews set decisions = $3::jsonb, updated_at = $4
      where job_id = $1 and role_id = $2`,
    [jobId, roleId, storedDecisions(kitKey, decisions), deps.clock.now()],
  );
  const now = await jobView(deps, jobId);
  const gate = now?.review?.gate ?? [];
  await deps.db.query(
    "update {{schema}}.kit_reviews set gate = $3::jsonb where job_id = $1 and role_id = $2",
    [jobId, roleId, JSON.stringify(gate)],
  );
  return { ok: true, decisions: now?.review?.decisions ?? decisions, gate };
}

/**
 * The checks of an email address the owner typed, made before the review
 * row is locked, since a lookup can take three seconds; none for a number,
 * or for an address that fails the strict check.
 */
async function typedChecks(
  deps: { db: Db; dns: Dns },
  jobId: string,
  value: string,
): Promise<AddressCheck[] | null> {
  const typed = value.trim();
  const role = await chosenRole(deps.db, jobId);
  const extraction = await currentExtraction(deps.db, jobId);
  if (role?.route.kind !== "email" || !extraction || !isStrictAddress(typed)) return null;
  return checkAddress(deps.dns, typed, extraction.record.company.name);
}

export async function recordReview(
  deps: { db: Db; clock: Clock; dns: Dns },
  jobId: string,
  action: ReviewAction,
): Promise<ReviewOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const checks = action.kind === "retype" ? await typedChecks(deps, jobId, action.value) : null;
  return deps.db.tx(async (tx): Promise<ReviewOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    if (!fits(action, view.kitParts)) return { ok: false, reason: "not-in-kit" };
    const decisions = decide(view.review?.decisions ?? NO_DECISIONS, action, checks);
    if (action.kind === "retype" && view.kitParts.contact) {
      const contact = contactForLedger(view.kitParts.contact.kind, action.value);
      const applicationId = await applicationIdOf(tx, jobId, view.role!.id);
      if (contact && applicationId) await setAddress(at, applicationId, contact);
    }
    return keep(at, jobId, view.role!.id, view.kitKey, decisions);
  });
}

/**
 * "Apply again" on the duplicate banner: covers the matches the banner
 * showed, and no others (ledger spec, "Duplicate check"), then keeps the
 * gate as it now stands.
 */
export async function applyAgainForJob(
  deps: { db: Db; clock: Clock },
  jobId: string,
  keys: readonly string[],
): Promise<ReviewOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx): Promise<ReviewOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    const shown = new Set(view.duplicates.map((match) => match.key));
    if (keys.length === 0 || !keys.every((key) => shown.has(key))) {
      return { ok: false, reason: "not-in-kit" };
    }
    const roleId = view.role!.id;
    // A kit that ran before applications opened with their jobs: its application opens now.
    if (!(await applicationIdOf(tx, jobId, roleId))) await kitReadyForJob(at, jobId);
    const applicationId = await applicationIdOf(tx, jobId, roleId);
    if (!applicationId) return { ok: false, reason: "not-ready" };
    await applyAgain(at, applicationId, keys);
    return keep(at, jobId, roleId, view.kitKey, view.review?.decisions ?? NO_DECISIONS);
  });
}
