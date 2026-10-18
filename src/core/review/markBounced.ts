import { chosenRole } from "@/core/extraction/owner";
import { changeStatus, undoStatus } from "@/core/ledger/statuses";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { keepGate, lockReview } from "./markSent";

/**
 * "Mark bounced" on a sent email (review spec, "Handoffs": on sent jobs;
 * ledger spec, "Statuses"): the email came back undelivered. The chosen
 * role's application moves from sent to bounced, with its audit row, under
 * the kit's review row's lock, so a Take back of the Mark sent made at the
 * same moment waits and then finds it bounced. The kit stays held as sent:
 * the email went. The page names the Mark sent it showed, by its time, so a
 * tap from a page drawn before the owner took that Mark sent back and marked
 * it sent again changes nothing. A second tap changes nothing.
 */

export type MarkBounced =
  { ok: true; changed: boolean } | { ok: false; reason: "not-found" | "not-sent" | "changed" };

export async function markBounced(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownSentAt: Date,
): Promise<MarkBounced> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx): Promise<MarkBounced> => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const application = await applicationOf(tx, jobId, role.id);
    if (application?.status !== "sent" && application?.status !== "bounced") {
      return { ok: false, reason: "not-sent" };
    }
    if (application.sentAt?.getTime() !== shownSentAt.getTime()) {
      return { ok: false, reason: "changed" };
    }
    const bounced = await changeStatus(at, application.id, "bounced", sessionId);
    if (!bounced.ok) return { ok: false, reason: "not-sent" };
    // The gate kept with the decisions, as every move of the kit's keeps it.
    if (bounced.changed) await keepGate(at, jobId, role.id);
    return { ok: true, changed: bounced.changed };
  });
}

/**
 * Takes back a mistaken Mark bounced (ledger spec, "Statuses"): the
 * application goes back to sent. The page names the bounce it showed, by
 * its time, so a late tap from a page drawn before the owner marked it
 * bounced again changes nothing.
 */
export async function takeBackBounced(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownBouncedAt: Date,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-bounced" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const application = await applicationOf(tx, jobId, role.id);
    if (application?.status !== "bounced") {
      return { ok: false as const, reason: "not-bounced" as const };
    }
    const undone = await undoStatus(
      at,
      application.id,
      { status: "bounced", at: shownBouncedAt },
      sessionId,
    );
    if (!undone.ok || !undone.changed) {
      return { ok: false as const, reason: "not-bounced" as const };
    }
    await keepGate(at, jobId, role.id);
    return { ok: true as const };
  });
}

/** The role's application, its status and when it was sent. */
async function applicationOf(
  db: Db,
  jobId: string,
  roleId: string,
): Promise<{ id: string; status: string; sentAt: Date | null } | undefined> {
  const { rows } = await db.query<{ id: string; status: string; sent_at: Date | null }>(
    "select id, status, sent_at from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  const row = rows[0];
  return row && { id: row.id, status: row.status, sentAt: row.sent_at };
}
