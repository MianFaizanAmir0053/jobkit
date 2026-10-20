import { chosenRole } from "@/core/extraction/owner";
import { changeStatus, setAddress, undoStatus } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { keepFinalDraft } from "./finalDraft";
import { applicationIdOf, kitRouteOf, openForJob } from "./applications";
import { jobView } from "./jobView";
import { keepGate, lockReview } from "./markSent";

/**
 * "Mark submitted" (review spec, "Handoffs"; ledger spec, "Statuses"): the
 * owner sent the application through the post's form, or as a message, with
 * the kit's words. Only a role whose route takes a form or a message kit is
 * marked submitted, as the application records it, the owner's pick of a
 * kit type included; an email is marked sent. It is done under the kit's
 * review row's lock, as Mark sent is: only a kit the gate released, as the
 * page showed it, is marked, since one it holds could not have been copied
 * from the page. The page names the kit and the WhatsApp number it showed,
 * so a Mark submitted from a page drawn on another, as in a tab the owner
 * has not looked at since typing the number again elsewhere, is refused,
 * and the ledger never keeps a number the message did not go to. The
 * chosen role's application, opened at the role pick or, for a job from
 * before that, here, keeps the number the message went to, the post's or
 * the one the owner typed in its place, and moves to kit_ready and
 * submitted, each with its audit row;
 * the gate kept with the decisions then holds the kit as gone. A refusal by
 * the ledger after these checks keeps nothing. A second tap changes nothing.
 */

export type MarkSubmitted =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "not-form-or-message" | "changed" | "held" | "refused";
    };

/**
 * What the page showed as the owner applied: the kit, and the number it
 * goes to ("" for none; null from a page that named none, as one drawn
 * before Mark submitted named it, which is refused as changed).
 */
export interface SubmittedFrom {
  kit: string;
  to: string | null;
}

/** A Mark submitted the status machine refused after the checks: its writes are rolled back. */
class SubmitRefused extends Error {}

export async function markSubmitted(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shown: SubmittedFrom,
): Promise<MarkSubmitted> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "kit_ready") return { ok: false, reason: "not-ready" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-ready" };
  const route = await kitRouteOf(deps.db, jobId, role);
  if (route !== "form" && route !== "message") return { ok: false, reason: "not-form-or-message" };
  try {
    return await deps.db.tx(async (tx): Promise<MarkSubmitted> =>
      submitting(deps, tx, jobId, role.id, sessionId, shown),
    );
  } catch (error) {
    if (error instanceof SubmitRefused) return { ok: false, reason: "refused" };
    throw error;
  }
}

/** Mark submitted itself, in one transaction under the review row's lock. */
async function submitting(
  deps: { db: Db; clock: Clock },
  tx: Db,
  jobId: string,
  roleId: string,
  sessionId: string | null,
  shown: SubmittedFrom,
): Promise<MarkSubmitted> {
  const at = { ...deps, db: tx };
  await lockReview(at, jobId, roleId);
  const view = await jobView(at, jobId);
  // The job as it stands under the lock: still ready, for the role whose row is locked.
  if (view?.state !== "kit_ready" || view.role?.id !== roleId || !view.review) {
    return { ok: false, reason: "not-ready" };
  }
  if (view.kitKey !== shown.kit || (view.handoff?.to ?? "") !== shown.to) {
    return { ok: false, reason: "changed" };
  }
  // A second tap on a kit already gone changes nothing; any other open reason holds it.
  if (view.review.gate.some((reason) => reason.kind !== "sent")) {
    return { ok: false, reason: "held" };
  }
  const applicationId =
    (await applicationIdOf(tx, jobId, roleId)) ?? (await openForJob(at, jobId, sessionId));
  if (!applicationId) return { ok: false, reason: "not-ready" };
  // The number the message went to, which duplicate checks then use, as Mark sent keeps an
  // address: the post's, or the one the owner typed in its place.
  if (view.handoff && view.handoff.to !== "") {
    await setAddress(at, applicationId, view.handoff.to);
  }
  // Already kit_ready, or submitted after an earlier tap: the next move decides.
  await changeStatus(at, applicationId, "kit_ready", sessionId);
  const submitted = await changeStatus(at, applicationId, "submitted", sessionId);
  // Unreached after the checks above; were it reached, nothing of the tap would be kept.
  if (!submitted.ok) throw new SubmitRefused();
  if (submitted.changed) {
    // The form or message as it went, the CV's label and the profile version (ledger spec).
    const { edits, deleted } = view.review.decisions;
    await keepFinalDraft(tx, applicationId, view, {
      draft: view.picked,
      to: view.handoff?.to ?? "",
      changed: [...Object.keys(edits), ...deleted],
    });
  }
  await keepGate(at, jobId, roleId);
  return { ok: true, changed: submitted.changed };
}

/**
 * Takes back a mistaken Mark submitted (ledger spec, "Statuses"): the
 * application goes back to kit_ready and the kit opens again. The page
 * names the Mark submitted it showed, by its time, so a late tap from a
 * page drawn before the owner marked it submitted again changes nothing.
 * One on a kit the page can no longer read is taken back too, as the
 * ledger allows every tap but two; that kit cannot be marked submitted
 * again, so its page does not offer it.
 */
export async function takeBackSubmitted(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownSubmittedAt: Date,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-submitted" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const { rows } = await tx.query<{ id: string; status: string }>(
      "select id, status from {{schema}}.applications where job_id = $1 and role_id = $2",
      [jobId, role.id],
    );
    const application = rows[0];
    if (application?.status !== "submitted") {
      return { ok: false as const, reason: "not-submitted" as const };
    }
    const undone = await undoStatus(
      at,
      application.id,
      { status: "submitted", at: shownSubmittedAt },
      sessionId,
    );
    if (!undone.ok || !undone.changed) {
      return { ok: false as const, reason: "not-submitted" as const };
    }
    await keepGate(at, jobId, role.id);
    return { ok: true as const };
  });
}
