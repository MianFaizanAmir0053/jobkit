import { chosenRole } from "@/core/extraction/owner";
import { changeStatus, setAddress } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";

import { applicationIdOf, openForJob } from "./applications";
import { NO_DECISIONS } from "./decisions";
import { jobView, storedDecisions } from "./jobView";

/**
 * "Mark sent" on a ready email kit (review spec, "Handoffs"; ledger spec,
 * "Statuses" and "Factual edits"): in one transaction, under the kit's
 * review row's lock, so a decision made at the same moment waits and then
 * finds the kit sent, the chosen role's application, opened at the role
 * pick or, for a job from before that, here, keeps the address the email
 * went to, the owner's typed one when the kit needed it. It is marked
 * kit_ready and sent, each with its audit row, and the kit's outcome is
 * recorded with the owner's answer to "Did you change anything in Gmail?",
 * so none of it is kept without the rest. Only a role whose route is email
 * is marked sent; a second tap changes nothing. Before real use there is no
 * timing arm.
 */

export type MarkSent =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "not-found" | "not-ready" | "not-email" | "refused" };

export async function markSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  answer: { changedInGmail: boolean },
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
    await tx.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, $2, $3::jsonb, '[]'::jsonb, $4) on conflict (job_id, role_id) do nothing`,
      [jobId, role.id, storedDecisions("", NO_DECISIONS), deps.clock.now()],
    );
    await tx.query(
      "select 1 from {{schema}}.kit_reviews where job_id = $1 and role_id = $2 for update",
      [jobId, role.id],
    );
    const view = await jobView(at, jobId);
    if (view?.state !== "kit_ready") return { ok: false, reason: "not-ready" };
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
      // No in-app edits yet (the editor comes later), so only Gmail can have changed a fact.
      await tx.query(
        `insert into {{schema}}.draft_outcomes
           (application_id, job_id, kind, changed_in_gmail, factual_edit, recorded_at)
         values ($1, $2, 'email', $3, $3, $4)
         on conflict (application_id) do update
           set changed_in_gmail = excluded.changed_in_gmail,
               factual_edit = excluded.factual_edit,
               recorded_at = excluded.recorded_at`,
        [applicationId, jobId, answer.changedInGmail, deps.clock.now()],
      );
    }
    return { ok: true, changed: sent.changed };
  });
}
