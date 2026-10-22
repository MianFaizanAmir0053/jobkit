import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { startJob } from "@/core/intake/jobs";
import { createJob, loadJob } from "@/core/platform/jobs";
import type { Random } from "@/core/ports";
import type { Handoff, HandoffPart } from "@/core/review/decisions";
import type { FinalDraft } from "@/core/review/finalDraft";
import { createLocalStorage } from "@/adapters/localStorage";
import { createTestDb } from "@/server/db/testDb";

import { armAt } from "./arms";
import { companyRoleHash } from "./normalise";
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
    `delete from {{schema}}.kit_sends; delete from {{schema}}.kit_reviews;
     delete from {{schema}}.status_changes; delete from {{schema}}.draft_outcomes;
     delete from {{schema}}.applications; delete from {{schema}}.upload_attempts;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs; delete from {{schema}}.arm_sequence`,
  );
});

/** A job of `arm` (none before real use) that went by `route`, `minutes` after it started. */
async function went(
  route: "email" | "form" | "message",
  minutes: number,
  arm: "tool" | "manual" | null,
) {
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

  it("records a manual run's Stop once, with its route, company and role, as an application of the manual arm that went", async () => {
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
    const { rows } = await db.query(
      `select route, company, role, company_role_hash, status, submitted_at, arm
         from {{schema}}.applications where job_id = $1`,
      [jobId],
    );
    // Gone at the tap, keyed for the duplicate log by the company and role the owner typed.
    expect(rows).toEqual([
      {
        route: "form",
        company: "Northwind",
        role: "Developer",
        company_role_hash: companyRoleHash("Northwind", "Developer"),
        status: "submitted",
        submitted_at: clock.now(),
        arm: "manual",
      },
    ]);
  });

  it("starts real use at the earliest of a handoff the review page kept, a send jobkit was asked for, and a kit that went", async () => {
    const at = (minutes: number) => new Date(clock.now().getTime() + minutes * MINUTE);
    const jobId = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    /** The review page's record of a handoff of the role's kit: its subject and body as last handed off. */
    const handedOff = async (roleId: string, subject: Date | null, body: Date | null) => {
      const part = (when: Date | null): HandoffPart | null =>
        when === null
          ? null
          : { draft: "gemini", words: "0f3a", changed: [], factual: false, at: when.toISOString() };
      const handoff: Handoff = {
        to: "jobs@example.com",
        typed: false,
        subject: part(subject),
        body: part(body),
      };
      await db.query(
        `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
         values ($1, $2, $3::jsonb, '[]', $4)`,
        [jobId, roleId, JSON.stringify({ handoff }), clock.now()],
      );
    };
    expect(await realUseStart(db)).toBeNull();

    // A send the owner undid: jobkit was still asked to send the email.
    await db.query(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, created_at, updated_at)
       values ($1, 'P1', 'kit', 'jobs@example.com', 'cancelled', $2, $2, $2)`,
      [jobId, at(40)],
    );
    expect(await realUseStart(db)).toEqual(at(40));

    // Copy email: the body handed off alone.
    await handedOff("P1", null, at(30));
    expect(await realUseStart(db)).toEqual(at(30));

    // Copy subject on another role's kit, earlier still: the subject handed off alone.
    await handedOff("P2", at(20), null);
    expect(await realUseStart(db)).toEqual(at(20));

    // A kit marked sent before any of them.
    await went("email", 10, null);
    expect(await realUseStart(db)).toEqual(at(10));
  });

  it("never starts real use from a manual run, though it went first", async () => {
    const manual = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    clock.advance(5 * MINUTE);
    const run = { route: "email" as const, company: "Northwind", role: "Developer" };
    expect(await recordManualRun({ db, clock }, manual, run, null)).toEqual({ ok: true });

    expect(await realUseStart(db)).toBeNull();

    const kitWent = new Date(clock.now().getTime() + 10 * MINUTE);
    await went("email", 10, null);
    expect(await realUseStart(db)).toEqual(kitWent);
  });

  it("compares the arms pooled only once each has 10 runs, though no route has 5", async () => {
    // Real use starts as the first kit goes, 30 minutes in; the runs below start after it.
    await went("email", 30, null);
    clock.advance(31 * MINUTE);
    const routes = ["email", "form", "message"] as const;
    for (let i = 0; i < 9; i++) {
      await went(routes[i % 3]!, 10 + i, "tool");
      await went(routes[i % 3]!, 40 + i, "manual");
    }

    expect((await statsReport(db)).comparison.pooled).toMatchObject({
      shown: false,
      tool: { count: 9 },
      manual: { count: 9 },
    });

    // Ten in one arm is not enough while the other has nine.
    await went("email", 19, "tool");
    expect((await statsReport(db)).comparison.pooled).toMatchObject({
      shown: false,
      tool: { count: 10 },
      manual: { count: 9 },
    });

    await went("email", 49, "manual");
    const report = await statsReport(db);
    expect(report.comparison.pooled).toMatchObject({
      shown: true,
      tool: { count: 10 },
      manual: { count: 10 },
    });
    expect(report.comparison.pooled.ratioInterval).not.toBeNull();
    // Four, three and three runs in each arm by route: no route is compared on its own.
    expect(Object.values(report.comparison.byRoute).map((each) => each.shown)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("counts the sentences the separate check held falsely from the final drafts kept, over real kits", async () => {
    /** A kit of a real job that went, its final draft keeping these false positives, or none kept. */
    const sent = async (judgeFalsePositives: string[] | null, kind: "real" | "test" = "real") => {
      const jobId = await went("email", 5, null);
      const finalDraft: FinalDraft | null = judgeFalsePositives && {
        draft: "gemini",
        kind: "email",
        subject: "Application: Developer",
        text: "I have built production React applications for four years.",
        to: "jobs@example.com",
        judgeFalsePositives,
      };
      await db.query(
        `update {{schema}}.applications set final_draft = $2::jsonb, job_kind = $3
          where job_id = $1`,
        [jobId, finalDraft && JSON.stringify(finalDraft), kind],
      );
    };
    expect((await statsReport(db)).judgeFalsePositives).toEqual({ sentences: 0, kits: 0 });

    await sent(["S1", "S3"]);
    await sent([]);
    // A final draft the purge cleared, and a test job's, count for nothing.
    await sent(null);
    await sent(["S2"], "test");

    expect((await statsReport(db)).judgeFalsePositives).toEqual({ sentences: 2, kits: 2 });
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
