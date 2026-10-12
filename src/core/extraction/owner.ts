import { loadJob, moveJob } from "@/core/platform/jobs";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db } from "@/core/ports";

import { type ExtractOutput, readExtractOutput } from "./extract";
import type { Role } from "./record";

/**
 * The owner's answers to extraction (extraction spec, "Stage extract" and
 * "Stage needs_role_pick"), and the rows of B9's table that extraction owns:
 * "This is a job post" after a "not a job post" stop, the role pick, and
 * Skip at the role pick. Each moves the job only from the state it was read
 * in, so two taps never act twice; the caller then starts the pipeline.
 */

type Deps = { db: Db; clock: Clock };
type Outcome<Reason extends string> = { ok: true } | { ok: false; reason: Reason };

/** The job's current extraction: extract's latest output, or null. */
export async function currentExtraction(db: Db, jobId: string): Promise<ExtractOutput | null> {
  const stored = await stageOutput(db, jobId, "extract");
  return stored ? readExtractOutput(stored.output) : null;
}

/** The role the job's chain works on: the owner's pick, or the post's only role. */
export async function chosenRole(db: Db, jobId: string): Promise<Role | null> {
  const extraction = await currentExtraction(db, jobId);
  if (!extraction) return null;
  const { rows } = await db.query<{ chosen_role: string | null }>(
    "select chosen_role from {{schema}}.jobs where id = $1",
    [jobId],
  );
  const roles = extraction.record.roles;
  const picked = rows[0]?.chosen_role ?? null;
  if (picked !== null) return roles.find((role) => role.id === picked) ?? null;
  return roles.length === 1 ? roles[0]! : null;
}

/**
 * "This is a job post": after a stop for "not a job post", and only then,
 * records the owner's confirmation, which extract's input hash covers, and
 * sends the job back to extract. A stop for language has Skip as its only
 * exit, and a post already confirmed is not confirmed again.
 */
export async function confirmPost(
  deps: Deps,
  jobId: string,
): Promise<Outcome<"not-found" | "not-a-post-stop">> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  const extraction = await currentExtraction(deps.db, jobId);
  const stoppedAsNoPost =
    job.state === "stopped" &&
    extraction !== null &&
    extraction.record.language === "en" &&
    extraction.record.post_kind === "not_a_job_post" &&
    !extraction.postConfirmed;
  if (!stoppedAsNoPost) return { ok: false, reason: "not-a-post-stop" };
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const moved = await moveJob(tx, jobId, {
      from: "stopped",
      to: "extracting",
      pending: "extract",
      at: now,
      ifChangedAt: job.stateChangedAt,
    });
    if (!moved) return { ok: false, reason: "not-a-post-stop" };
    await tx.query("update {{schema}}.jobs set post_confirmed_at = $2 where id = $1", [jobId, now]);
    return { ok: true };
  });
}

/** The owner picks one of a post's roles; the chain goes on with it, from eligibility. */
export async function pickRole(
  deps: Deps,
  jobId: string,
  roleId: string,
): Promise<Outcome<"not-found" | "not-waiting" | "no-such-role">> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "needs_role_pick") return { ok: false, reason: "not-waiting" };
  const extraction = await currentExtraction(deps.db, jobId);
  if (!extraction?.record.roles.some((role) => role.id === roleId)) {
    return { ok: false, reason: "no-such-role" };
  }
  return deps.db.tx(async (tx) => {
    const moved = await moveJob(tx, jobId, {
      from: "needs_role_pick",
      to: "checking",
      pending: "eligibility",
      at: deps.clock.now(),
      ifChangedAt: job.stateChangedAt,
    });
    if (!moved) return { ok: false, reason: "not-waiting" };
    await tx.query("update {{schema}}.jobs set chosen_role = $2 where id = $1", [jobId, roleId]);
    return { ok: true };
  });
}

/**
 * Skip at the role pick closes the job. B9 sends it back to `kit_ready`
 * instead when another role already has a kit, which needs picking another
 * role from a ready kit; that comes with the job page's full role menu.
 */
export async function skipRolePick(
  deps: Deps,
  jobId: string,
): Promise<Outcome<"not-found" | "not-waiting">> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "needs_role_pick") return { ok: false, reason: "not-waiting" };
  const moved = await moveJob(deps.db, jobId, {
    from: "needs_role_pick",
    to: "closed",
    pending: null,
    at: deps.clock.now(),
    ifChangedAt: job.stateChangedAt,
  });
  return moved ? { ok: true } : { ok: false, reason: "not-waiting" };
}
