import { isStrictAddress } from "@/core/extraction/contacts";
import { chosenRole, currentExtraction } from "@/core/extraction/owner";
import { changeStatus, openApplication } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";

/**
 * "Mark sent" on a ready email kit (review spec, "Handoffs"; ledger spec,
 * "Statuses" and "Factual edits"): the chosen role's application is opened,
 * if this is its first kit, then marked kit_ready and sent, each with its
 * audit row, and the kit's outcome is recorded with the owner's answer to
 * "Did you change anything in Gmail?" in the same transaction as sent, so
 * neither is kept without the other. Only a role whose route is email is
 * marked sent; a second tap changes nothing. Before real use there is no
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
  const extraction = await currentExtraction(deps.db, jobId);
  const role = await chosenRole(deps.db, jobId);
  if (!extraction || !role) return { ok: false, reason: "not-ready" };
  // Sending another way is Mark submitted, which comes with form and message kits.
  if (role.route.kind !== "email") return { ok: false, reason: "not-email" };
  const address = role.route.address;
  const applicationId = await openApplication(
    deps,
    {
      jobId,
      roleId: role.id,
      company: extraction.record.company.name,
      role: role.title,
      address: isStrictAddress(address) ? address : null,
      route: "email",
      requirements: role.requirements.map((requirement) => requirement.text),
      arm: null,
      jobKind: "real",
    },
    sessionId,
  );
  // Already kit_ready, or sent, after an earlier tap: the next move decides.
  await changeStatus(deps, applicationId, "kit_ready", sessionId);
  return deps.db.tx(async (tx): Promise<MarkSent> => {
    const sent = await changeStatus({ ...deps, db: tx }, applicationId, "sent", sessionId);
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
