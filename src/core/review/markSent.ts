import { chosenRole } from "@/core/extraction/owner";
import { sameAddress } from "@/core/ledger/normalise";
import { changeStatus, setAddress, undoStatus } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, openForJob } from "./applications";
import { NO_DECISIONS } from "./decisions";
import { jobView, storedDecisions } from "./jobView";

/**
 * "Mark sent" on a ready email kit (review spec, "Handoffs"; ledger spec,
 * "Statuses" and "Factual edits"): in one transaction, under the kit's
 * review row's lock, so a decision made at the same moment waits and then
 * finds the kit sent. Only a kit the gate released is marked sent: one it
 * holds could not have gone from the page. The chosen role's application,
 * opened at the role pick or, for a job from before that, here, keeps the
 * address the email went to, the owner's typed one when the kit needed it.
 * It is marked kit_ready and sent, each with its audit row, and the kit's
 * outcome is recorded with the owner's answer to "Did you change anything
 * in Gmail?", so none of it is kept without the rest; an address the owner
 * typed in place of the one jobkit read is an edit of the address, and a
 * factual edit (ledger spec, "Factual edits"). The gate kept with the
 * decisions then says the kit is sent. The page names the kit and the
 * address it showed: a Mark sent from a page drawn on another, as in a tab
 * the owner has not looked at since typing the address again elsewhere, is
 * refused, so the ledger never keeps an address the email did not go to.
 * Only a role whose route is email is marked sent; a second tap changes
 * nothing. Before real use there is no timing arm.
 */

export type MarkSent =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "not-email" | "held" | "refused" | "changed";
    };

/** The kit and the address the page showed as the owner sent it. */
export interface SentFrom {
  kit?: string;
  to?: string;
}

/** Locks a job's review row, made first if need be, so decisions and Mark sent take turns. */
async function lockReview(deps: { db: Db; clock: Clock }, jobId: string, roleId: string) {
  await deps.db.query(
    `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
     values ($1, $2, $3::jsonb, '[]'::jsonb, $4) on conflict (job_id, role_id) do nothing`,
    [jobId, roleId, storedDecisions("", NO_DECISIONS), deps.clock.now()],
  );
  await deps.db.query(
    "select 1 from {{schema}}.kit_reviews where job_id = $1 and role_id = $2 for update",
    [jobId, roleId],
  );
}

/** Keeps the gate as the kit now stands in the review row. */
async function keepGate(deps: { db: Db; clock: Clock }, jobId: string, roleId: string) {
  const view = await jobView(deps, jobId);
  await deps.db.query(
    `update {{schema}}.kit_reviews set gate = $3::jsonb, updated_at = $4
      where job_id = $1 and role_id = $2`,
    [jobId, roleId, JSON.stringify(view?.review?.gate ?? []), deps.clock.now()],
  );
}

export async function markSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  answer: { changedInGmail: boolean },
  shown: SentFrom = {},
): Promise<MarkSent> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "kit_ready") return { ok: false, reason: "not-ready" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-ready" };
  // Sending another way is Mark submitted, which comes with form and message kits.
  if (role.route.kind !== "email") return { ok: false, reason: "not-email" };
  return deps.db.tx(async (tx): Promise<MarkSent> => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const view = await jobView(at, jobId);
    if (view?.state !== "kit_ready" || !view.review) return { ok: false, reason: "not-ready" };
    const to = view.handoff?.to ?? "";
    if (
      (shown.kit !== undefined && shown.kit !== view.kitKey) ||
      (shown.to !== undefined && shown.to !== to)
    ) {
      return { ok: false, reason: "changed" };
    }
    // A second tap on a kit already sent changes nothing; any other open reason holds it.
    const held = view.review.gate.filter((reason) => reason.kind !== "sent");
    if (held.length > 0) return { ok: false, reason: "held" };
    const applicationId =
      (await applicationIdOf(tx, jobId, role.id)) ?? (await openForJob(at, jobId, sessionId));
    if (!applicationId) return { ok: false, reason: "not-ready" };
    // The address the email went to: the owner's, when the kit needed them to type one.
    if (view.handoff?.typed && view.handoff.to !== "") {
      await setAddress(at, applicationId, view.handoff.to);
    }
    // Already kit_ready, or sent, after an earlier tap: the next move decides.
    await changeStatus(at, applicationId, "kit_ready", sessionId);
    const sent = await changeStatus(at, applicationId, "sent", sessionId);
    if (!sent.ok) return { ok: false, reason: "refused" };
    if (sent.changed) {
      // Until the editor exists, the one field the owner changes in jobkit is the address.
      const changed =
        view.handoff?.typed && !sameAddress(to, role.route.address) ? ["address"] : [];
      await tx.query(
        `insert into {{schema}}.draft_outcomes
           (application_id, job_id, kind, changed, changed_in_gmail, factual_edit, recorded_at)
         values ($1, $2, 'email', $3, $4, $5, $6)
         on conflict (application_id) do update
           set changed = excluded.changed,
               changed_in_gmail = excluded.changed_in_gmail,
               factual_edit = excluded.factual_edit,
               recorded_at = excluded.recorded_at`,
        [
          applicationId,
          jobId,
          changed,
          answer.changedInGmail,
          answer.changedInGmail || changed.length > 0,
          deps.clock.now(),
        ],
      );
    }
    await keepGate(at, jobId, role.id);
    return { ok: true, changed: sent.changed };
  });
}

/**
 * Takes back a mistaken Mark sent (ledger spec, "Statuses"): the application
 * goes back to kit_ready, its outcome with it, and the kit opens again. The
 * page names the Mark sent it showed, by its time, so a late tap from a
 * page drawn before the owner marked it sent again changes nothing.
 */
export async function takeBackSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownSentAt?: Date,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-sent" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const { rows } = await tx.query<{ id: string; status: string; status_changed_at: Date }>(
      `select id, status, status_changed_at from {{schema}}.applications
        where job_id = $1 and role_id = $2`,
      [jobId, role.id],
    );
    const application = rows[0];
    if (application?.status !== "sent") return { ok: false as const, reason: "not-sent" as const };
    const undone = await undoStatus(
      at,
      application.id,
      { status: "sent", at: shownSentAt ?? application.status_changed_at },
      sessionId,
    );
    if (!undone.ok || !undone.changed) return { ok: false as const, reason: "not-sent" as const };
    await keepGate(at, jobId, role.id);
    return { ok: true as const };
  });
}
