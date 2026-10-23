import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createJob, loadJob, retryJob } from "@/core/platform/jobs";
import type { JobState } from "@/core/platform/jobStates";
import { createTestDb } from "@/server/db/testDb";

import { recordAnotherWay, recordManualRun, takeBackOldWay } from "./statuses";
import { statsReport } from "./statsReport";

/*
 * Applying the old way, and taking it back (ledger spec, "The timing
 * comparison" and "Statuses"; ledger AC4): Stop on a manual run, and "I
 * applied another way" on a job of jobkit's arm that failed or stopped,
 * which stays in jobkit's arm; both opened again as they were by a take-back.
 */

let db: PgliteDb;
let clock: FakeClock;
const MINUTE = 60_000;
const deps = () => ({ db, clock });
const run = { route: "email" as const, company: "Northwind", role: "Developer" };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  await db.exec(
    `delete from {{schema}}.status_changes; delete from {{schema}}.applications;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.measurement;
     delete from {{schema}}.jobs`,
  );
});

/** A job drawn into `arm`, standing in `state` as the runner or the owner left it. */
async function jobIn(
  state: JobState,
  arm: "tool" | "manual" | null = "tool",
  failed: { stage: string; reason: string } | null = null,
) {
  const id = await createJob(db, {
    state: "uploading",
    receivedAt: clock.now(),
    clientElapsedMs: 0,
    arm: arm && { arm, index: 0, from: null },
  });
  await db.query(
    `update {{schema}}.jobs set state = $2, state_changed_at = $3, pending_stage = $4,
            failed_stage = $4, failure = $5
      where id = $1`,
    [id, state, clock.now(), failed?.stage ?? null, failed?.reason ?? null],
  );
  return (await loadJob(db, id))!;
}

const applicationsOf = async (jobId: string) =>
  (
    await db.query<{ role_id: string; route: string; status: string; arm: string }>(
      "select role_id, route, status, arm from {{schema}}.applications where job_id = $1",
      [jobId],
    )
  ).rows;

describe("I applied another way", () => {
  it("records a failed job of jobkit's arm as gone in jobkit's arm, and takes it back to the step it failed at", async () => {
    const job = await jobIn("failed", "tool", { stage: "draft", reason: "The draft failed." });
    clock.advance(30 * MINUTE);
    const shown = { state: job.state, at: job.stateChangedAt };

    expect(await recordAnotherWay(deps(), job.id, run, shown, null)).toEqual({ ok: true });
    const closed = (await loadJob(db, job.id))!;
    expect(closed.state).toBe("closed");
    expect(await applicationsOf(job.id)).toEqual([
      { role_id: "another-way", route: "email", status: "sent", arm: "tool" },
    ]);
    // Its time, from the job's start to the tap, is jobkit's.
    expect((await statsReport(db)).comparison.byRoute.email.tool).toMatchObject({
      count: 1,
      medianMs: 30 * MINUTE,
    });

    expect(await takeBackOldWay(deps(), job.id, closed.stateChangedAt)).toEqual({ ok: true });
    expect(await loadJob(db, job.id)).toMatchObject({
      state: "failed",
      pendingStage: "draft",
      failedStage: "draft",
      failure: "The draft failed.",
    });
    expect(await applicationsOf(job.id)).toEqual([]);
    // As it was: Retry runs the step again, and a second take-back finds nothing to take.
    expect(await takeBackOldWay(deps(), job.id, closed.stateChangedAt)).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(await retryJob(deps(), job.id)).toEqual({ ok: true });
  });

  it("opens a stopped job, or one whose upload failed, again in the state it was applied from", async () => {
    for (const state of ["stopped", "upload_failed"] as const) {
      const job = await jobIn(state);
      clock.advance(MINUTE);
      expect(
        await recordAnotherWay(
          deps(),
          job.id,
          { ...run, route: "form" },
          {
            state,
            at: job.stateChangedAt,
          },
          null,
        ),
      ).toEqual({ ok: true });
      expect((await applicationsOf(job.id))[0]).toMatchObject({ status: "submitted" });
      const closedAt = (await loadJob(db, job.id))!.stateChangedAt;

      expect(await takeBackOldWay(deps(), job.id, closedAt)).toEqual({ ok: true });
      expect((await loadJob(db, job.id))?.state).toBe(state);
    }
  });

  it("is not offered for the old way's arm, a job outside the arms, a test job or one not stuck, nor from a stale page", async () => {
    const tapped = async (job: Awaited<ReturnType<typeof jobIn>>, at = job.stateChangedAt) =>
      recordAnotherWay(deps(), job.id, run, { state: job.state, at }, null);

    expect(await tapped(await jobIn("failed", "manual", { stage: "draft", reason: "x" }))).toEqual({
      ok: false,
      reason: "not-offered",
    });
    expect(await tapped(await jobIn("stopped", null))).toEqual({
      ok: false,
      reason: "not-offered",
    });
    expect(await tapped(await jobIn("kit_ready"))).toEqual({ ok: false, reason: "not-offered" });
    const test = await jobIn("stopped");
    await db.query("update {{schema}}.jobs set kind = 'test' where id = $1", [test.id]);
    expect(await tapped({ ...test, test: true })).toEqual({ ok: false, reason: "not-offered" });

    // A page drawn before the job last moved names another time.
    const stale = await jobIn("stopped");
    expect(await tapped(stale, new Date(stale.stateChangedAt.getTime() - MINUTE))).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(await applicationsOf(stale.id)).toEqual([]);
  });
});

describe("taking back Stop", () => {
  it("opens the manual run again, its clock still running from the job's start, and Stop records it anew", async () => {
    const job = await jobIn("manual_run", "manual");
    clock.advance(20 * MINUTE);
    expect(await recordManualRun(deps(), job.id, run, null)).toEqual({ ok: true });
    const closedAt = (await loadJob(db, job.id))!.stateChangedAt;

    expect(await takeBackOldWay(deps(), job.id, closedAt)).toEqual({ ok: true });
    expect((await loadJob(db, job.id))?.state).toBe("manual_run");
    expect(await applicationsOf(job.id)).toEqual([]);

    clock.advance(10 * MINUTE);
    expect(await recordManualRun(deps(), job.id, run, null)).toEqual({ ok: true });
    expect((await statsReport(db)).comparison.byRoute.email.manual).toMatchObject({
      count: 1,
      medianMs: 30 * MINUTE,
    });
  });
});
