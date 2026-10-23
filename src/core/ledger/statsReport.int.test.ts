import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { startJob } from "@/core/intake/jobs";
import { createJob, loadJob } from "@/core/platform/jobs";
import type { Random } from "@/core/ports";
import type { FinalDraft } from "@/core/review/finalDraft";
import { createLocalStorage } from "@/adapters/localStorage";
import { createTestDb } from "@/server/db/testDb";

import { armAt } from "./arms";
import { companyRoleHash } from "./normalise";
import { noteRealUse, realUseStart } from "./realUse";
import { recordManualRun } from "./statuses";
import { statsReport } from "./statsReport";
import { setTestMode, TEST_MODE_MS } from "./testMode";

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
     delete from {{schema}}.job_stage_runs; delete from {{schema}}.job_leases;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.measurement; delete from {{schema}}.jobs;
     delete from {{schema}}.arm_sequence`,
  );
});

/**
 * A job of `arm` (none before real use) that went by `route`, `minutes`
 * after it started; one not of the manual arm starts real use, as Mark sent
 * would, unless something did before.
 */
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
  if (arm !== "manual") await noteRealUse(db, jobId, at);
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

    // The sequence the seed sets decides each job's arm, which the job keeps with its place; the
    // manual arm's job runs nothing. Each is another post, so each draws.
    const seed = fixed(7).bytes(32);
    for (let i = 0; i < 6; i++) {
      const started = await startJob(
        { ...deps, random: fixed(7) },
        { ...job, pastedText: `Post ${i}.` },
      );
      if (!started.ok) throw new Error(started.message);
      const arm = armAt(seed, i);
      expect(await loadJob(db, started.jobId)).toMatchObject({
        state: arm === "manual" ? "manual_run" : "queued",
        arm,
      });
      expect(Boolean(started.manual)).toBe(arm === "manual");
      const { rows } = await db.query("select arm_index from {{schema}}.jobs where id = $1", [
        started.jobId,
      ]);
      expect(rows).toEqual([{ arm_index: i }]);
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

  it("keeps the arm a post first took when it is shared again, drawing no new place", async () => {
    const deps = { db, clock, storage: createLocalStorage({ root: ".", origin: "http://x" }) };
    const start = (pastedText: string, hashes: string[] = []) =>
      startJob(
        { ...deps, random: fixed(7) },
        {
          images: hashes.map((sha256) => ({
            contentType: "image/png" as const,
            bytes: 100,
            width: 10,
            height: 10,
            sha256,
          })),
          pastedText,
          clientElapsedMs: 0,
        },
      );
    const armOf = async (jobId: string) =>
      (
        await db.query<{ arm: string; arm_index: number | null; arm_from: string | null }>(
          "select arm, arm_index, arm_from from {{schema}}.jobs where id = $1",
          [jobId],
        )
      ).rows[0];
    await went("email", 10, null);
    clock.advance(11 * MINUTE);

    const first = await start("Northwind is hiring a developer.");
    if (!first.ok) throw new Error(first.message);
    const drawn = await armOf(first.jobId);
    expect(drawn).toMatchObject({ arm_index: 0, arm_from: null });

    // The same words, spaced otherwise, are the same post: its first arm, and no new place.
    const again = await start("Northwind  is hiring\na developer.");
    if (!again.ok) throw new Error(again.message);
    expect(await armOf(again.jobId)).toEqual({
      arm: drawn!.arm,
      arm_index: null,
      arm_from: first.jobId,
    });

    // A screenshot the post was first shared with is the same post, though more come with it.
    const shot = (n: number) => n.toString(16).padStart(64, "0");
    const screenshots = await start("", [shot(1)]);
    if (!screenshots.ok) throw new Error(screenshots.message);
    const more = await start("", [shot(1), shot(2)]);
    if (!more.ok) throw new Error(more.message);
    expect((await armOf(more.jobId))?.arm_from).toBe(screenshots.jobId);

    // Another post draws the next place.
    const other = await start("Fabrikam is hiring a designer.");
    if (!other.ok) throw new Error(other.message);
    expect((await armOf(other.jobId))?.arm_index).toBe(2);
  });

  it("tells what became of each arm's jobs: went, left without going, still open, shared again", async () => {
    const drawn = (arm: "tool" | "manual", from: string | null = null) =>
      createJob(db, {
        state: "manual_run",
        receivedAt: clock.now(),
        clientElapsedMs: 0,
        arm: { arm, index: from === null ? 0 : null, from },
        postHashes: ["a".repeat(64)],
      });
    const toolWent = await drawn("tool");
    await db.query(
      `insert into {{schema}}.applications
         (job_id, role_id, company, role, role_key, route, status, opened_at, sent_at,
          status_changed_at, arm, job_kind)
       values ($1, 'P1', 'Northwind', 'Developer', 'developer', 'email', 'sent', $2, $2, $2,
               'tool', 'real')`,
      [toolWent, clock.now()],
    );
    const toolLeft = await drawn("tool");
    const manualLeft = await drawn("manual");
    await db.query("update {{schema}}.jobs set state = 'closed' where id = any($1::uuid[])", [
      [toolLeft, manualLeft],
    ]);
    // Skipped, then shared again: the old way still, and open.
    await drawn("manual", manualLeft);

    expect((await statsReport(db)).arms).toEqual({
      tool: { drawn: 2, went: 1, left: 1, open: 0, sharedAgain: 0 },
      manual: { drawn: 2, went: 0, left: 1, open: 1, sharedAgain: 1 },
    });
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

  it("records the start of real use once, at the first event on a real job, and nothing later moves it", async () => {
    const at = (minutes: number) => new Date(clock.now().getTime() + minutes * MINUTE);
    const job = () =>
      createJob(db, { state: "manual_run", receivedAt: clock.now(), clientElapsedMs: 0 });
    // A test job's handoff, and a manual run's, start nothing.
    const test = await job();
    await db.query("update {{schema}}.jobs set kind = 'test' where id = $1", [test]);
    await noteRealUse(db, test, at(10));
    const manual = await job();
    await db.query("update {{schema}}.jobs set arm = 'manual' where id = $1", [manual]);
    await noteRealUse(db, manual, at(15));
    expect(await realUseStart(db)).toBeNull();

    // A real job's first event starts it.
    const first = await job();
    await noteRealUse(db, first, at(30));
    expect(await realUseStart(db)).toEqual(at(30));

    // A later event, though it names an earlier time, leaves it where it was, and so does the
    // purge of the job whose event started it.
    await noteRealUse(db, await job(), at(20));
    await db.query("delete from {{schema}}.job_state_changes where job_id = $1", [first]);
    await db.query("delete from {{schema}}.jobs where id = $1", [first]);
    expect(await realUseStart(db)).toEqual(at(30));
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

  it("makes every job a test job while test mode is on: it draws no arm, and no figure counts it", async () => {
    const deps = { db, clock, storage: createLocalStorage({ root: ".", origin: "http://x" }) };
    const job = { images: [], pastedText: "A post.", clientElapsedMs: 0 };
    // Real use has started, so a real job would be drawn into an arm.
    await went("email", 10, null);
    clock.advance(11 * MINUTE);
    await setTestMode({ db, clock }, true);

    const started = await startJob({ ...deps, random: fixed(7) }, job);
    if (!started.ok) throw new Error(started.message);
    // It runs as any job of jobkit's does, but takes no place in the sequence.
    expect(await loadJob(db, started.jobId)).toMatchObject({ state: "queued", test: true });
    expect((await db.query("select next_index from {{schema}}.arm_sequence")).rows).toEqual([]);

    // Its upload and its steps count for nothing on the Stats page.
    const lease = "77777777-7777-4777-8777-777777777777";
    await db.query(
      "insert into {{schema}}.job_leases (id, job_id, claimed_at, expires_at) values ($1, $2, $3, $3)",
      [lease, started.jobId, clock.now()],
    );
    await db.query(
      `insert into {{schema}}.job_stage_runs
         (job_id, lease_id, stage, round, attempt, outcome, started_at, ended_at)
       values ($1, $2, 'extract', 0, 1, 'ok', $3, $3)`,
      [started.jobId, lease, clock.now()],
    );
    await db.query(
      `insert into {{schema}}.upload_attempts (job_id, started_at, files, bytes, outcome, ended_at)
       values ($1, $2, 1, 100, 'failed', $2)`,
      [started.jobId, clock.now()],
    );
    expect(await statsReport(db)).toMatchObject({
      uploads: { ok: 0, failed: 0, rate: null },
      stages: [],
    });

    // Once the hour is up, a job is a real one again.
    clock.advance(TEST_MODE_MS);
    const real = await startJob({ ...deps, random: fixed(7) }, { ...job, pastedText: "Another." });
    if (!real.ok) throw new Error(real.message);
    expect((await loadJob(db, real.jobId))?.test).toBe(false);
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

  it("counts a run in the arm it was drawn into, though the phone held its share from before real use began", async () => {
    // Real use starts as the first kit goes, 30 minutes in.
    await went("email", 30, null);
    clock.advance(31 * MINUTE);
    // A share the phone held for an hour reaches jobkit now, and is the tool arm's.
    const jobId = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 60 * MINUTE,
    });
    const at = new Date(clock.now().getTime() + 10 * MINUTE);
    await db.query(
      `insert into {{schema}}.applications
         (job_id, role_id, company, role, role_key, route, status, opened_at, sent_at,
          status_changed_at, arm, job_kind)
       values ($1, 'P1', 'Northwind', 'Developer', 'developer', 'email', 'sent', $2, $2, $2,
               'tool', 'real')`,
      [jobId, at],
    );

    // Its time runs from the share, an hour before it arrived and so before real use began.
    expect((await statsReport(db)).comparison.byRoute.email.tool).toMatchObject({
      count: 1,
      medianMs: 70 * MINUTE,
    });
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
