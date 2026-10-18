import { chosenRole } from "@/core/extraction/owner";
import { sameAddress } from "@/core/ledger/normalise";
import { changeStatus, setAddress, undoStatus } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, kitRouteOf, openForJob } from "./applications";
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
 * nothing. Before real use there is no timing arm. An email jobkit sent
 * from the owner's Gmail (decisions A20) is marked sent the same way, with
 * nothing changed in Gmail, and cannot be taken back: it went.
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
export async function lockReview(deps: { db: Db; clock: Clock }, jobId: string, roleId: string) {
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
export async function keepGate(deps: { db: Db; clock: Clock }, jobId: string, roleId: string) {
  const view = await jobView(deps, jobId);
  await deps.db.query(
    `update {{schema}}.kit_reviews set gate = $3::jsonb, updated_at = $4
      where job_id = $1 and role_id = $2`,
    [jobId, roleId, JSON.stringify(view?.review?.gate ?? []), deps.clock.now()],
  );
}

export function markSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  answer: { changedInGmail: boolean },
  shown: SentFrom = {},
): Promise<MarkSent> {
  return marking(deps, jobId, sessionId, answer, { by: "owner", shown });
}

/**
 * An email jobkit sent from the owner's Gmail (decisions A20), marked sent
 * as Mark sent marks one, nothing changed in Gmail, at the address it went
 * to. It went, so nothing on a page, nor a reason that now holds the kit,
 * refuses it.
 */
export function markSentByJobkit(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  to: string,
): Promise<MarkSent> {
  return marking(deps, jobId, sessionId, { changedInGmail: false }, { by: "jobkit", to });
}

/** Who marks the kit sent: the owner, from the page they saw, or jobkit, which sent it to `to`. */
type Marker = { by: "owner"; shown: SentFrom } | { by: "jobkit"; to: string };

/** A Mark sent the status machine refused after the checks: its writes are rolled back. */
class SendRefused extends Error {}

async function marking(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  answer: { changedInGmail: boolean },
  marker: Marker,
): Promise<MarkSent> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "kit_ready") return { ok: false, reason: "not-ready" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-ready" };
  // Sending another way is Mark submitted, for form and message kits.
  if ((await kitRouteOf(deps.db, jobId, role)) !== "email")
    return { ok: false, reason: "not-email" };
  try {
    return await deps.db.tx(async (tx): Promise<MarkSent> => {
      const at = { ...deps, db: tx };
      await lockReview(at, jobId, role.id);
      const view = await jobView(at, jobId);
      if (view?.state !== "kit_ready" || !view.review) return { ok: false, reason: "not-ready" };
      const shownTo = view.handoff?.to ?? "";
      if (marker.by === "owner") {
        const { shown } = marker;
        if (
          (shown.kit !== undefined && shown.kit !== view.kitKey) ||
          (shown.to !== undefined && shown.to !== shownTo)
        ) {
          return { ok: false, reason: "changed" };
        }
        // A second tap on a kit already sent changes nothing; any other open reason holds it.
        const held = view.review.gate.filter((reason) => reason.kind !== "sent");
        if (held.length > 0) return { ok: false, reason: "held" };
      }
      // The address the email went to: the one jobkit sent it to, or the one the page showed.
      const to = marker.by === "jobkit" ? marker.to : shownTo;
      const typed =
        marker.by === "jobkit"
          ? !sameAddress(to, role.route.address)
          : Boolean(view.handoff?.typed);
      const applicationId =
        (await applicationIdOf(tx, jobId, role.id)) ?? (await openForJob(at, jobId, sessionId));
      if (!applicationId) return { ok: false, reason: "not-ready" };
      // jobkit's own move, under no session's tap: the email went, whatever the owner tapped since.
      if (marker.by === "jobkit") await unskipped(at, applicationId, null);
      // The address the email went to: the post's, the owner's typed in its place, or the one jobkit
      // sent it to, whatever the owner typed since.
      if (to !== "") await setAddress(at, applicationId, to);
      // Already kit_ready, or sent, after an earlier tap: the next move decides.
      await changeStatus(at, applicationId, "kit_ready", sessionId);
      const sent = await changeStatus(at, applicationId, "sent", sessionId);
      // Unreached after the checks above; were it reached, nothing of the tap would be kept.
      if (!sent.ok) throw new SendRefused();
      if (sent.changed) {
        // Until the editor exists, the one field the owner changes in jobkit is the address.
        const changed = typed && !sameAddress(to, role.route.address) ? ["address"] : [];
        await tx.query(
          `insert into {{schema}}.draft_outcomes
           (application_id, job_id, kind, changed, changed_in_gmail, factual_edit, recorded_at,
            draft)
         values ($1, $2, 'email', $3, $4, $5, $6, $7)
         on conflict (application_id) do update
           set changed = excluded.changed,
               changed_in_gmail = excluded.changed_in_gmail,
               factual_edit = excluded.factual_edit,
               recorded_at = excluded.recorded_at,
               draft = excluded.draft`,
          [
            applicationId,
            jobId,
            changed,
            answer.changedInGmail,
            answer.changedInGmail || changed.length > 0,
            deps.clock.now(),
            // Which draft went (decisions A22): Gemini's, or a template's, the owner's own words.
            view.picked,
          ],
        );
      }
      await keepGate(at, jobId, role.id);
      return { ok: true, changed: sent.changed };
    });
  } catch (error) {
    if (error instanceof SendRefused) return { ok: false, reason: "refused" };
    throw error;
  }
}

/**
 * Takes back a skip of the application, if it was skipped: an email jobkit
 * was sending went after the owner skipped the job past the warning that it
 * may have gone. It went, so it is sent, with the audit rows of both moves
 * (ledger spec, "Statuses"). Were the take-back refused, marking it sent is
 * refused next, and the delivery says it could not record it.
 */
async function unskipped(
  deps: { db: Db; clock: Clock },
  applicationId: string,
  sessionId: string | null,
): Promise<void> {
  const { rows } = await deps.db.query<{ status: string; skipped_at: Date | null }>(
    "select status, skipped_at from {{schema}}.applications where id = $1",
    [applicationId],
  );
  const row = rows[0];
  if (row?.status === "skipped" && row.skipped_at) {
    await undoStatus(deps, applicationId, { status: "skipped", at: row.skipped_at }, sessionId);
  }
}

/**
 * Takes back a mistaken Mark sent (ledger spec, "Statuses"): the application
 * goes back to kit_ready, its outcome with it, and the kit opens again. The
 * page names the Mark sent it showed, by its time, so a late tap from a
 * page drawn before the owner marked it sent again changes nothing. An
 * email jobkit sent is not taken back: it went (decisions A20). One on a
 * kit the page can no longer read is taken back too, as the ledger allows;
 * that kit cannot be marked sent again, so its page does not offer it.
 */
export async function takeBackSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownSentAt?: Date,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-sent" | "sent-by-jobkit" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const { rows } = await tx.query<{ id: string; status: string; sent_at: Date | null }>(
      `select id, status, sent_at from {{schema}}.applications
        where job_id = $1 and role_id = $2`,
      [jobId, role.id],
    );
    const application = rows[0];
    if (application?.status !== "sent" || !application.sent_at) {
      return { ok: false as const, reason: "not-sent" as const };
    }
    const byJobkit = await tx.query(
      `select 1 from {{schema}}.kit_sends
        where job_id = $1 and role_id = $2 and status = 'sent' limit 1`,
      [jobId, role.id],
    );
    if (byJobkit.rows.length > 0) {
      return { ok: false as const, reason: "sent-by-jobkit" as const };
    }
    const undone = await undoStatus(
      at,
      application.id,
      { status: "sent", at: shownSentAt ?? application.sent_at },
      sessionId,
    );
    if (!undone.ok || !undone.changed) return { ok: false as const, reason: "not-sent" as const };
    await keepGate(at, jobId, role.id);
    return { ok: true as const };
  });
}
