import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { startJob } from "@/core/intake/jobs";
import { createJob, loadJob } from "@/core/platform/jobs";
import type { Random } from "@/core/ports";
import { createLocalStorage } from "@/adapters/localStorage";
import { createTestDb } from "@/server/db/testDb";

import { armAt } from "./arms";
import { realUseStart } from "./realUse";
import { recordManualRun } from "./statuses";
import { statsReport } from "./statsReport";

/*
 * The Stats page's figures and the timing arms (ledger spec, "The timing
 * comparison" and "Timing and stats"; ledger AC4 and AC5): real use starts
 * at the first kit that went, each job made since is drawn into an arm, a
 * manual run's Stop records its application, and the comparison shows only
 * from enough runs in each arm.
 */

let db: PgliteDb;
let clock: FakeClock;

const fixed = (byte: number): Random => ({ bytes: (length) => new Uint8Array(length).fill(byte) });
const MINUTE = 60_000;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  await db.exec(
    `delete from {{schema}}.status_changes; delete from {{schema}}.draft_outcomes;
     delete from {{schema}}.applications; delete from {{schema}}.upload_attempts;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs; delete from {{schema}}.arm_sequence`,
  );
});

/** A job of the tool arm that went by `route`, `minutes` after it started. */
async function went(route: "email" | "form", minutes: number, arm: "tool" | null) {
  const started = clock.now();
  const jobId = await createJob(db, {
    state: "manual_run",
    receivedAt: started,
    clientElapsedMs: 0,
  });
  const at = new Date(started.getTime() + minutes * MINUTE);
  await db.query(
    `insert into {{schema}}.applications
       (job_id, role_id, company, role, role_key, route, status, opened_at, sent_at, submitted_at,
        status_changed_at, arm, job_kind)
     values ($1, 'P1', 'Northwind', 'Developer', 'developer', $2, $3, $4, $5, $6, $4, $7, 'real')`,
    [
      jobId,
      route,
      route === "email" ? "sent" : "submitted",
      at,
      route === "email" ? at : null,
      route === "email" ? null : at,
      arm,
    ],
  );
  return jobId;
}

describe("the timing arms and the Stats page", () => {
  it("starts real use at the first kit that went, then draws each new job into an arm", async () => {
    const deps = { db, clock, storage: createLocalStorage({ root: ".", origin: "http://x" }) };
    const job = { images: [], pastedText: "A post.", clientElapsedMs: 0 };
    // Before real use, no arm: the job runs.
    const before = await startJob({ ...deps, random: fixed(7) }, job);
    expect(before).toMatchObject({ ok: true, queued: true });
    expect(await realUseStart(db)).toBeNull();

    await went("email", 10, null);
    expect(await realUseStart(db)).not.toBeNull();
    clock.advance(11 * MINUTE);

    // The sequence the seed sets decides each job's arm; the manual arm's job runs nothing.
    const seed = fixed(7).bytes(32);
    for (let i = 0; i < 6; i++) {
      const started = await startJob({ ...deps, random: fixed(7) }, job);
      if (!started.ok) throw new Error(started.message);
      const arm = armAt(seed, i);
      expect((await loadJob(db, started.jobId))?.state).toBe(
        arm === "manual" ? "manual_run" : "queued",
      );
      expect(Boolean(started.manual)).toBe(arm === "manual");
    }

    // Four weeks from the start of real use the comparison ends: no place is drawn, the job runs.
    clock.advance(28 * 24 * 60 * MINUTE);
    expect(await startJob({ ...deps, random: fixed(7) }, job)).toMatchObject({
      ok: true,
      queued: true,
    });
    const { rows } = await db.query<{ next_index: number }>(
      "select next_index from {{schema}}.arm_sequence",
    );
    expect(rows).toEqual([{ next_index: 6 }]);
  });

  it("records a manual run's Stop once, as an application of the manual arm that went", async () => {
    const jobId = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    clock.advance(25 * MINUTE);
    const run = { route: "form" as const, company: "Northwind", role: "Developer" };

    expect(await recordManualRun({ db, clock }, jobId, run, null)).toEqual({ ok: true });
    expect(await recordManualRun({ db, clock }, jobId, run, null)).toEqual({
      ok: false,
      reason: "not-a-manual-run",
    });
    expect((await loadJob(db, jobId))?.state).toBe("closed");
    const { rows } = await db.query<{ status: string; arm: string; company_role_hash: string }>(
      "select status, arm, company_role_hash from {{schema}}.applications where job_id = $1",
      [jobId],
    );
    expect(rows).toMatchObject([{ status: "submitted", arm: "manual" }]);
    expect(rows[0]!.company_role_hash).toBeTruthy();
  });

  it("compares the arms' total times only from enough runs in each arm, during real use", async () => {
    // Real use starts as the first kit goes, 30 minutes in; the runs below start after it.
    await went("email", 30, null);
    clock.advance(31 * MINUTE);
    for (let i = 0; i < 5; i++) await went("email", 10 + i, "tool");
    const manualRun = async (minutes: number) => {
      const jobId = await createJob(db, {
        state: "manual_run",
        receivedAt: clock.now(),
        clientElapsedMs: 0,
      });
      clock.advance(minutes * MINUTE);
      await recordManualRun(
        { db, clock },
        jobId,
        { route: "email", company: `Company ${minutes}`, role: "Developer" },
        null,
      );
      clock.advance(-minutes * MINUTE);
    };
    for (let i = 0; i < 4; i++) await manualRun(40 + i);

    const short = await statsReport(db);
    expect(short.comparison.byRoute.email).toMatchObject({
      shown: false,
      tool: { count: 5 },
      manual: { count: 4 },
    });

    await manualRun(44);
    const report = await statsReport(db);
    const email = report.comparison.byRoute.email;
    expect(email).toMatchObject({ shown: true, tool: { medianMs: 12 * MINUTE } });
    expect(email.manual.medianMs).toBe(42 * MINUTE);
    expect(email.ratio).toBeCloseTo(3.5);
    expect(email.ratioInterval!.low).toBeLessThanOrEqual(3.5);
    expect(email.ratioInterval!.high).toBeGreaterThanOrEqual(3.5);
    // Pooled needs ten in each arm; the run before real use counts in total time, never the ratio.
    expect(report.comparison.pooled.shown).toBe(false);
    expect(report.total.byRoute.email.count).toBe(6);
  });

  it("times a job once though two of its roles went, and counts both kits in the route mix", async () => {
    const jobId = await went("email", 10, null);
    const later = new Date(clock.now().getTime() + 20 * MINUTE);
    await db.query(
      `insert into {{schema}}.applications
         (job_id, role_id, company, role, role_key, route, status, opened_at, sent_at,
          status_changed_at, job_kind)
       values ($1, 'P2', 'Northwind', 'Designer', 'designer', 'email', 'sent', $2, $2, $2, 'real')`,
      [jobId, later],
    );

    const report = await statsReport(db);
    expect(report.total.pooled).toMatchObject({ count: 1, medianMs: 10 * MINUTE });
    expect(report.routeMix.email).toBe(2);
  });

  it("reports the factual-edit rate with its interval, and an upload still open whose job moved on as failed", async () => {
    for (const factual of [true, false, false, false]) {
      const jobId = await went("email", 5, null);
      await db.query(
        `insert into {{schema}}.draft_outcomes
           (application_id, job_id, kind, changed_in_gmail, factual_edit, recorded_at)
         select id, job_id, 'email', false, $2, $3 from {{schema}}.applications where job_id = $1`,
        [jobId, factual, clock.now()],
      );
      clock.advance(MINUTE);
    }
    const queued = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    await db.query(
      `insert into {{schema}}.upload_attempts (job_id, started_at, files, bytes, outcome, ended_at)
       values ($1, $2, 1, 100, 'ok', $2), ($1, $2, 1, 100, 'failed', $2)`,
      [queued, clock.now()],
    );
    await db.query(
      `insert into {{schema}}.upload_attempts (job_id, started_at, files, bytes)
       values ($1, $2, 1, 100)`,
      [queued, clock.now()],
    );

    const report = await statsReport(db);
    expect(report.factualEdits).toMatchObject({ edits: 1, outcomes: 4, rate: 0.25 });
    expect(report.factualEdits.interval!.low).toBeCloseTo(0.0456, 3);
    expect(report.factualEdits.interval!.high).toBeCloseTo(0.6994, 3);
    expect(report.trustGate).toMatchObject({ unlocked: false, cleanStreak: 3 });
    expect(report.uploads).toEqual({ ok: 1, failed: 2, rate: 1 / 3 });
  });
});
