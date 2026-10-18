import { chosenRole } from "@/core/extraction/owner";
import { changeStatus, undoStatus } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, openForJob } from "./applications";
import { jobView } from "./jobView";
import { keepGate, lockReview } from "./markSent";

/**
 * "Mark submitted" (review spec, "Handoffs"; ledger spec, "Statuses"): the
 * owner sent the application through the post's form, or as a message, with
 * the kit's words. Only a role whose route takes a form or a message kit is
 * marked submitted; an email is marked sent. It is done under the kit's
 * review row's lock, as Mark sent is: only a kit the gate released, as the
 * page showed it, is marked, since one it holds could not have been copied
 * from the page. The chosen role's application, opened at the role pick
 * or, for a job from before that, here, moves to kit_ready and submitted,
 * each with its audit row, and the gate kept with the decisions then holds
 * the kit as gone. A second tap changes nothing.
 */

export type MarkSubmitted =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "not-form-or-message" | "changed" | "held" | "refused";
    };

/** The routes whose kit is a form or a message (drafting spec, "Kit type"). */
const SUBMITTED_ROUTES: ReadonlySet<string> = new Set([
  "ats_form",
  "easy_apply",
  "careers_page",
  "whatsapp",
  "linkedin_dm",
  "linkedin_comment",
]);

export async function markSubmitted(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownKit: string,
): Promise<MarkSubmitted> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "kit_ready") return { ok: false, reason: "not-ready" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-ready" };
  if (!SUBMITTED_ROUTES.has(role.route.kind)) return { ok: false, reason: "not-form-or-message" };
  return deps.db.tx(async (tx): Promise<MarkSubmitted> => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const view = await jobView(at, jobId);
    if (view?.state !== "kit_ready" || !view.review) return { ok: false, reason: "not-ready" };
    if (view.kitKey !== shownKit) return { ok: false, reason: "changed" };
    // A second tap on a kit already gone changes nothing; any other open reason holds it.
    if (view.review.gate.some((reason) => reason.kind !== "sent")) {
      return { ok: false, reason: "held" };
    }
    const applicationId =
      (await applicationIdOf(tx, jobId, role.id)) ?? (await openForJob(at, jobId, sessionId));
    if (!applicationId) return { ok: false, reason: "not-ready" };
    // Already kit_ready, or submitted after an earlier tap: the next move decides.
    await changeStatus(at, applicationId, "kit_ready", sessionId);
    const submitted = await changeStatus(at, applicationId, "submitted", sessionId);
    if (!submitted.ok) return { ok: false, reason: "refused" };
    await keepGate(at, jobId, role.id);
    return { ok: true, changed: submitted.changed };
  });
}

/**
 * Takes back a mistaken Mark submitted (ledger spec, "Statuses"): the
 * application goes back to kit_ready and the kit opens again. The page
 * names the Mark submitted it showed, by its time, so a late tap from a
 * page drawn before the owner marked it submitted again changes nothing.
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
