import { chosenRole } from "@/core/extraction/owner";
import type { Role } from "@/core/extraction/record";
import { type Route, setRoute } from "@/core/ledger/statuses";
import { loadJob, moveJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, kitRouteOf, openForJob } from "./applications";
import { lockReview } from "./markSent";

/**
 * The kit-type pick (drafting spec, "Kit type"; review spec, "Job page"): a
 * post whose route is other or unknown waits in `needs_kit_type` until the
 * owner names the kind of kit, an email, a form or a message. The pick is
 * kept as the application's route, which drafting, the page and the ledger
 * then follow, under the review row's lock, so a decision made at the same
 * moment waits for it; and the job goes on to drafting. It is taken only
 * from the page that showed the job waiting since that time: a second tap,
 * or a page drawn before the job moved on, changes nothing.
 */
export async function pickKitType(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  pick: { kit: Route; since: Date },
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-waiting" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "needs_kit_type" || job.stateChangedAt.getTime() !== pick.since.getTime()) {
    return { ok: false, reason: "not-waiting" };
  }
  try {
    return await deps.db.tx(async (tx) => {
      const at = { ...deps, db: tx };
      const role = await chosenRole(tx, jobId);
      if (!role) return { ok: false as const, reason: "not-waiting" as const };
      await lockReview(at, jobId, role.id);
      const applicationId =
        (await applicationIdOf(tx, jobId, role.id)) ?? (await openForJob(at, jobId, sessionId));
      if (!applicationId) return { ok: false as const, reason: "not-waiting" as const };
      await setRoute(at, applicationId, pick.kit);
      const moved = await moveJob(tx, jobId, {
        from: "needs_kit_type",
        to: "drafting",
        pending: "templates",
        at: deps.clock.now(),
        ifChangedAt: job.stateChangedAt,
      });
      // Moved on meanwhile: the route set above is rolled back with the rest.
      if (!moved) throw new PickRefused();
      return { ok: true as const };
    });
  } catch (error) {
    if (error instanceof PickRefused) return { ok: false, reason: "not-waiting" };
    throw error;
  }
}

/** A pick the job moved on from after it was read: nothing of it is kept. */
class PickRefused extends Error {}

/**
 * The kind of kit a job takes, as the app's pipeline gives it to extraction
 * and drafting (KitOf): the application's route, the owner's pick included,
 * else its role's route's.
 */
export const kitOfJob = (db: Db, jobId: string, role: Role) => kitRouteOf(db, jobId, role);
