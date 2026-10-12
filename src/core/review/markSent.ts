import { isStrictAddress } from "@/core/extraction/contacts";
import { chosenRole, currentExtraction } from "@/core/extraction/owner";
import { changeStatus, openApplication } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";

/**
 * "Mark sent" on a ready email kit (review spec; ledger spec, "Statuses"):
 * the chosen role's application is opened, if this is its first kit, then
 * marked kit_ready and sent, each with its audit row. A second tap changes
 * nothing. Before real use there is no timing arm, and on the thin path
 * every kit is an email kit, so the application's route is email.
 */

export type MarkSent =
  { ok: true; changed: boolean } | { ok: false; reason: "not-found" | "not-ready" | "refused" };

export async function markSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
): Promise<MarkSent> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "kit_ready") return { ok: false, reason: "not-ready" };
  const extraction = await currentExtraction(deps.db, jobId);
  const role = await chosenRole(deps.db, jobId);
  if (!extraction || !role) return { ok: false, reason: "not-ready" };
  const { kind, address } = role.route;
  const applicationId = await openApplication(
    deps,
    {
      jobId,
      roleId: role.id,
      company: extraction.record.company.name,
      role: role.title,
      address: kind === "email" && isStrictAddress(address) ? address : null,
      route: "email",
      requirements: role.requirements.map((requirement) => requirement.text),
      arm: null,
      jobKind: "real",
    },
    sessionId,
  );
  // Already kit_ready, or sent, after an earlier tap: the next move decides.
  await changeStatus(deps, applicationId, "kit_ready", sessionId);
  const sent = await changeStatus(deps, applicationId, "sent", sessionId);
  return sent.ok ? { ok: true, changed: sent.changed } : { ok: false, reason: "refused" };
}
