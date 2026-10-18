import { chosenRole, skipRolePick } from "@/core/extraction/owner";
import { changeStatus, setAddress, undoStatus } from "@/core/ledger/statuses";
import { loadJob, skipJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, openForJob, skippedForJob } from "./applications";
import { jobView } from "./jobView";
import { anySent, isLive, latestSend, uncertainSend } from "./kitSends";
import { keepGate, lockReview } from "./markSent";

/**
 * Skip on a ready kit (review spec, "Handoffs": always available; ledger
 * spec, "Statuses"): the owner will not apply. The chosen role's
 * application moves from kit_ready to skipped, with its audit row, while the
 * job and its kit stay as they are, so the owner can take the skip back
 * from the page. It is done under the kit's review row's lock, as Mark sent
 * is, on the kit the page showed, and the gate kept with the decisions then
 * holds every outbound control. A kit that went, or one jobkit is sending,
 * is not skipped; one whose send may have gone is skipped only from a page
 * that warned about it. A kit the page can no longer read is skipped too,
 * while its post can still be read. A kit that ran before its application
 * opened with it opens one here, with the address the owner typed. A second
 * tap changes nothing.
 */

export type SkipKit =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "changed" | "sent" | "sending" | "uncertain" | "refused";
    };

/**
 * What the page showed as the owner pressed Skip: the kit, null when the
 * page could not read one, and the send it warned may have gone, if any.
 */
export interface SkipFrom {
  kit: string | null;
  uncertain: string | null;
}

/** A skip the status machine refused after the checks: its writes are rolled back. */
class SkipRefused extends Error {}

export async function skipKit(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shown: SkipFrom,
): Promise<SkipKit> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (job.state !== "kit_ready" || !role) return { ok: false, reason: "not-ready" };
  try {
    return await deps.db.tx(async (tx): Promise<SkipKit> =>
      skipping(deps, tx, jobId, role.id, sessionId, shown),
    );
  } catch (error) {
    if (error instanceof SkipRefused) return { ok: false, reason: "refused" };
    throw error;
  }
}

/** The skip itself, in one transaction under the review row's lock. */
async function skipping(
  deps: { db: Db; clock: Clock },
  tx: Db,
  jobId: string,
  roleId: string,
  sessionId: string | null,
  shown: SkipFrom,
): Promise<SkipKit> {
  const at = { ...deps, db: tx };
  await lockReview(at, jobId, roleId);
  const view = await jobView(at, jobId);
  // The job as it stands under the lock: still ready, for the role whose row is locked.
  if (view?.state !== "kit_ready" || view.role?.id !== roleId) {
    return { ok: false, reason: "not-ready" };
  }
  if (view.kitKey !== shown.kit) return { ok: false, reason: "changed" };
  if (view.went) return { ok: false, reason: "sent" };
  const now = deps.clock.now();
  const latest = await latestSend(tx, jobId, roleId);
  if (latest && isLive(latest, now)) return { ok: false, reason: "sending" };
  // A send that may have gone is skipped past only from a page that warned about it.
  const uncertain = await uncertainSend(tx, jobId, roleId, now);
  if ((uncertain?.id ?? null) !== shown.uncertain) return { ok: false, reason: "uncertain" };
  const applicationId =
    (await applicationIdOf(tx, jobId, roleId)) ?? (await openForJob(at, jobId, sessionId));
  if (!applicationId) return { ok: false, reason: "not-ready" };
  // The address the owner typed in place of the post's, which duplicate checks then use, as
  // Mark sent keeps it.
  if (view.handoff?.typed && view.handoff.to !== "") {
    await setAddress(at, applicationId, view.handoff.to);
  }
  // Already kit_ready, or skipped after an earlier tap: the next move decides.
  await changeStatus(at, applicationId, "kit_ready", sessionId);
  const skipped = await changeStatus(at, applicationId, "skipped", sessionId);
  // Unreached after the checks above; were it reached, nothing of the skip would be kept.
  if (!skipped.ok) throw new SkipRefused();
  await keepGate(at, jobId, roleId);
  return { ok: true, changed: skipped.changed };
}

/**
 * Skip on a page waiting on the owner (platform spec B9): closes the job
 * from the state the page showed, as it showed it, by when the job reached
 * it, the role pick's included, and skips its
 * application, if a role was ever chosen (ledger spec, "Statuses"), in one
 * transaction, so a skip cut short leaves both as they were and can be
 * tried again. A job whose kit's send may have gone, as when a Gemini draft
 * asked for beside the templates' then failed, closes only from a page that
 * warned of that send: a skip that closes its job is never taken back.
 */
export async function closeSkipped(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shown: { state: string; since?: Date; uncertain: string | null },
): Promise<
  { ok: true } | { ok: false; reason: "not-found" | "not-skippable" | "not-waiting" | "uncertain" }
> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    const role = await chosenRole(tx, jobId);
    const uncertain = role ? await uncertainSend(tx, jobId, role.id, deps.clock.now()) : null;
    if ((uncertain?.id ?? null) !== shown.uncertain) {
      return { ok: false as const, reason: "uncertain" as const };
    }
    const moved =
      shown.state === "needs_role_pick"
        ? await skipRolePick(at, jobId, shown.since)
        : await skipJob(at, jobId, shown.state, shown.since);
    if (moved.ok) await skippedForJob(at, jobId, sessionId);
    return moved;
  });
}

/**
 * Takes back a skip of a ready kit (ledger spec, "Statuses"): the
 * application goes back to kit_ready and the kit opens again. The page
 * names the skip it showed, by its time, so a late tap from a page drawn
 * before the owner skipped again changes nothing. A skip that closed its
 * job, before a kit or after a failure, is not taken back: the job stays
 * closed (platform spec B9). Nor is the skip of an email Gmail took, which
 * went, though the ledger may not have recorded it.
 */
export async function takeBackSkip(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownSkippedAt: Date,
): Promise<
  { ok: true } | { ok: false; reason: "not-found" | "not-ready" | "not-skipped" | "sent" }
> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (job.state !== "kit_ready" || !role) return { ok: false, reason: "not-ready" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const now = await loadJob(tx, jobId);
    if (now?.state !== "kit_ready" || (await chosenRole(tx, jobId))?.id !== role.id) {
      return { ok: false as const, reason: "not-ready" as const };
    }
    if (await anySent(tx, jobId, role.id)) return { ok: false as const, reason: "sent" as const };
    const { rows } = await tx.query<{ id: string; status: string }>(
      "select id, status from {{schema}}.applications where job_id = $1 and role_id = $2",
      [jobId, role.id],
    );
    const application = rows[0];
    if (application?.status !== "skipped") {
      return { ok: false as const, reason: "not-skipped" as const };
    }
    const undone = await undoStatus(
      at,
      application.id,
      { status: "skipped", at: shownSkippedAt },
      sessionId,
    );
    if (!undone.ok || !undone.changed) {
      return { ok: false as const, reason: "not-skipped" as const };
    }
    await keepGate(at, jobId, role.id);
    return { ok: true as const };
  });
}
