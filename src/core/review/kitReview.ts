import { isStrictAddress } from "@/core/extraction/contacts";
import { chosenRole, currentExtraction } from "@/core/extraction/owner";
import { applyAgain } from "@/core/ledger/duplicates";
import { setAddress } from "@/core/ledger/statuses";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db, Dns } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { type AddressCheck, checkAddress } from "./addressChecks";
import type { AddressChecksOutput } from "./addressChecksStage";
import { applicationIdOf, contactForLedger, kitReadyForJob } from "./applications";
import type { GateReason } from "./canHandOff";
import {
  decide,
  emailKey,
  flagKey,
  isEdited,
  isMeetable,
  keptLookup,
  type KitParts,
  NO_DECISIONS,
  type ReviewAction,
  type ReviewDecisions,
} from "./decisions";
import { type JobView, jobView, storedDecisions } from "./jobView";

/**
 * Recording the owner's decisions on a ready kit (review spec, "The
 * outbound gate"): one decision at a time, checked against what the kit
 * holds and refused when the page that made it showed another kit, kept in
 * the job's kit_reviews row for the kit it was made on, with the gate's
 * open reasons as they then stand. The row is locked before the kit is
 * read, so two decisions made at once are both kept, and a decision made
 * as the kit is marked sent finds it sent and is refused. An email address
 * the owner types is checked like the post's (review spec, "Stage
 * address_checks"), once: the checks first found for it stand. When it
 * passes, it becomes the application's, so the duplicate check runs on it
 * (ledger spec, "Duplicate check"). "Apply again" goes to the ledger, which
 * keeps it on the application, opening one for a kit that ran before
 * applications opened with their jobs. While jobkit sends the email
 * (decisions A20), no decision is taken, so nothing changes what it sends.
 */

export type ReviewOutcome =
  | { ok: true; decisions: ReviewDecisions; gate: GateReason[] }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "not-in-kit" | "sent" | "skipped" | "changed" | "sending";
    };

/** Why a decision, or a send, finds no kit to act on as the page showed it. */
type Refusal = { ok: false; reason: "not-found" | "not-ready" | "sent" | "skipped" | "changed" };

/** The kit the page showed, which a decision names, and the session whose tap it is. */
export interface DecisionMade {
  kit?: string;
  sessionId?: string | null;
}

/** Whether the kit has a place for the decision. */
function fits(action: ReviewAction, parts: KitParts, decisions: ReviewDecisions): boolean {
  switch (action.kind) {
    case "edit":
    case "revert":
      return parts.blocks.includes(action.blockId);
    // Only an edited sentence is confirmed.
    case "confirm":
      return parts.blocks.includes(action.blockId) && isEdited(decisions, action.blockId);
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
    // Withdrawn on any draft, as one carried by a pick to a draft whose row takes no tick.
    case "meets":
      return (
        !action.ticked ||
        parts.flags.some((flag) => isMeetable(flag) && flag.at === action.requirementId)
      );
  }
}

/**
 * Locks the job's review row, made first if need be, and reads the kit as it
 * then stands: a refusal when there is no ready kit to decide on, when the
 * page showed another kit, when it was marked sent, or when the owner skipped
 * it, until the skip is taken back.
 */
export async function lockedKit(
  deps: { db: Db; clock: Clock },
  jobId: string,
  made: DecisionMade,
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
  if (made.kit !== undefined && made.kit !== kitKey) return { ok: false, reason: "changed" };
  if (kitParts.sent) return { ok: false, reason: "sent" };
  if (kitParts.skipped) return { ok: false, reason: "skipped" };
  return { view: { ...view, kitParts, kitKey } };
}

/** Keeps the decisions for the kit, then the gate as the kit now stands with them. */
export async function keep(
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
  // Under the row's lock the kit stays ready: losing it here undoes the decision, never keeps it.
  if (!now?.review) throw new Error(`The kit of job ${jobId} was gone as its decision was kept.`);
  await deps.db.query(
    "update {{schema}}.kit_reviews set gate = $3::jsonb where job_id = $1 and role_id = $2",
    [jobId, roleId, JSON.stringify(now.review.gate)],
  );
  return { ok: true, decisions: now.review.decisions, gate: now.review.gate };
}

/**
 * What the address_checks stage found for the post's own address, which
 * stands for it when the owner types it again; null when the stage checked
 * another address, or when what it found came from an older strict check
 * the address now passes.
 */
async function postedChecks(db: Db, jobId: string, typed: string): Promise<AddressCheck[] | null> {
  const output = (await stageOutput(db, jobId, "address_checks"))?.output as
    AddressChecksOutput | undefined;
  if (!output?.checked || emailKey(output.address) !== emailKey(typed)) return null;
  return output.checks.some((check) => check.kind === "syntax") ? null : output.checks;
}

/**
 * The checks of an email address the owner typed, made before the review
 * row is locked, since a lookup can take three seconds. An address is
 * looked up once: the post's own, typed again in any case, keeps what the
 * address checks found for it, and one typed before keeps the checks first
 * found for it, so a later lookup that fails, as offline, never washes out
 * one that found the address takes no mail. None for a number, or for an
 * address that fails the strict check.
 */
async function typedChecks(
  deps: { db: Db; clock: Clock; dns: Dns },
  jobId: string,
  value: string,
): Promise<AddressCheck[] | null> {
  const typed = value.trim();
  const role = await chosenRole(deps.db, jobId);
  const extraction = await currentExtraction(deps.db, jobId);
  if (role?.route.kind !== "email" || !extraction || !isStrictAddress(typed)) return null;
  const decisions = (await jobView(deps, jobId))?.review?.decisions ?? NO_DECISIONS;
  return (
    (await postedChecks(deps.db, jobId, typed)) ??
    keptLookup(decisions, typed) ??
    (await checkAddress(deps.dns, typed, extraction.record.company.name))
  );
}

export async function recordReview(
  deps: { db: Db; clock: Clock; dns: Dns },
  jobId: string,
  action: ReviewAction,
  made: DecisionMade = {},
): Promise<ReviewOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const checks = action.kind === "retype" ? await typedChecks(deps, jobId, action.value) : null;
  return deps.db.tx(async (tx): Promise<ReviewOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, made);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    // While jobkit sends the email, nothing changes what it sends (decisions A20).
    if (view.kitParts.sending) return { ok: false, reason: "sending" };
    const before = view.review?.decisions ?? NO_DECISIONS;
    if (!fits(action, view.kitParts, before)) return { ok: false, reason: "not-in-kit" };
    // Words written back as drafted are no edit.
    const drafted = view.draft!.kit.blocks.find(
      (block) => action.kind === "edit" && block.id === action.blockId,
    );
    const taken: ReviewAction =
      action.kind === "edit" && drafted !== undefined && action.text.trim() === drafted.text
        ? { kind: "revert", blockId: action.blockId }
        : action;
    const decisions = decide(before, taken, checks);
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
 * gate as it now stands. A kit from before applications opened with their
 * jobs has its application opened, by the owner's tap, at the address the
 * kit goes to.
 */
export async function applyAgainForJob(
  deps: { db: Db; clock: Clock },
  jobId: string,
  keys: readonly string[],
  made: DecisionMade = {},
): Promise<ReviewOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx): Promise<ReviewOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, made);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    if (view.kitParts.sending) return { ok: false, reason: "sending" };
    const shown = new Set(view.duplicates.map((match) => match.key));
    if (keys.length === 0 || !keys.every((key) => shown.has(key))) {
      return { ok: false, reason: "not-in-kit" };
    }
    const roleId = view.role!.id;
    if (!(await applicationIdOf(tx, jobId, roleId))) {
      await kitReadyForJob(at, jobId, made.sessionId ?? null);
    }
    const applicationId = await applicationIdOf(tx, jobId, roleId);
    if (!applicationId) return { ok: false, reason: "not-ready" };
    const typed = view.handoff?.typed && view.handoff.to !== "" ? view.handoff.to : null;
    const contact =
      typed && view.kitParts.contact ? contactForLedger(view.kitParts.contact.kind, typed) : null;
    if (contact) await setAddress(at, applicationId, contact);
    await applyAgain(at, applicationId, keys);
    return keep(at, jobId, roleId, view.kitKey, view.review?.decisions ?? NO_DECISIONS);
  });
}
