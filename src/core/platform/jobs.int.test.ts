import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import type { Db } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { createJob, expireUploads, jobStatus, loadJob, moveJob, retryJob, skipJob } from "./jobs";
import { type JobState, kindOf, type StageName } from "./jobStates";

let db: PgliteDb;
const clock = fakeClock();
const MINUTE = 60_000;
const MISSING = "99999999-9999-4999-8999-999999999999";

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.job_state_changes; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.jobs`,
  );
});

async function changes(jobId: string) {
  const { rows } = await db.query<{ from_state: string | null; to_state: string; at: Date }>(
    `select from_state, to_state, at from {{schema}}.job_state_changes
      where job_id = $1 order by id`,
    [jobId],
  );
  return rows;
}

/** A lease on the job, as the runner holds one when it moves a running job. */
async function held(id: string): Promise<string> {
  const { rows } = await db.query<{ lease_id: string }>(
    `update {{schema}}.jobs set lease_id = gen_random_uuid(), lease_expires_at = $2
      where id = $1 returning lease_id`,
    [id, new Date(clock.now().getTime() + 330_000)],
  );
  return rows[0]!.lease_id;
}

type Step =
  [JobState, StageName | null] | [JobState, StageName, { stage: StageName; reason: string }];

// A new job walked along the given moves, under a lease wherever it is running.
async function jobIn(state: "uploading" | "manual_run", steps: Step[] = []): Promise<string> {
  const id = await createJob(db, { state, receivedAt: clock.now(), clientElapsedMs: 4_000 });
  let from: JobState = state;
  let leaving: StageName | null = null;
  for (const [to, pending, failure] of steps) {
    const running = kindOf(from) === "running";
    const leaseId = running ? await held(id) : undefined;
    const fromPending = running ? leaving : undefined;
    const move = { from, to, pending, at: clock.now(), leaseId, fromPending, failure };
    expect(await moveJob(db, id, move)).toBe(true);
    from = to;
    leaving = pending;
  }
  return id;
}

const failedAt = (pending: StageName, reason = "It broke."): Step => [
  "failed",
  pending,
  { stage: pending, reason },
];

describe("createJob", () => {
  it("records the state the job starts in, and when the phone took it in", async () => {
    const id = await jobIn("uploading");

    expect(await loadJob(db, id)).toMatchObject({
      state: "uploading",
      pendingStage: null,
      receivedAt: clock.now(),
      clientElapsedMs: 4_000,
      retryRound: 0,
      leaseId: null,
    });
    expect(await changes(id)).toEqual([
      { from_state: null, to_state: "uploading", at: clock.now() },
    ]);
  });

  it("rounds the phone's elapsed time to whole milliseconds, and refuses one that cannot be a duration", async () => {
    const created = (clientElapsedMs: number) =>
      createJob(db, { state: "uploading", receivedAt: clock.now(), clientElapsedMs });

    expect(await loadJob(db, await created(1234.6))).toMatchObject({ clientElapsedMs: 1235 });
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(created(bad)).rejects.toThrow(RangeError);
    }
  });
});

describe("moveJob", () => {
  it("moves a job along the table and records each change with its time", async () => {
    const id = await jobIn("uploading");
    clock.advance(1_000);

    expect(
      await moveJob(db, id, { from: "uploading", to: "queued", pending: null, at: clock.now() }),
    ).toBe(true);

    expect(await loadJob(db, id)).toMatchObject({ state: "queued", stateChangedAt: clock.now() });
    expect((await changes(id)).map((change) => change.to_state)).toEqual(["uploading", "queued"]);
  });

  it("refuses every move outside the table, changing nothing", async () => {
    const id = await jobIn("uploading");

    await expect(
      moveJob(db, id, { from: "uploading", to: "kit_ready", pending: null, at: clock.now() }),
    ).rejects.toThrow(/cannot move/);
    await expect(
      moveJob(db, id, { from: "uploading", to: "queued", pending: "extract", at: clock.now() }),
    ).rejects.toThrow(/no pending stage/);

    expect(await loadJob(db, id)).toMatchObject({ state: "uploading" });
    expect(await changes(id)).toHaveLength(1);
  });

  it("does nothing when the job has already left the state the move starts from", async () => {
    const id = await jobIn("uploading", [["queued", null]]);

    expect(
      await moveJob(db, id, {
        from: "uploading",
        to: "upload_failed",
        pending: null,
        at: clock.now(),
      }),
    ).toBe(false);
    expect(await loadJob(db, id)).toMatchObject({ state: "queued" });
  });

  it("moves a running job only for the invocation holding its live lease", async () => {
    const id = await jobIn("uploading", [["queued", null]]);
    const toExtracting = {
      from: "queued",
      to: "extracting",
      pending: "extract",
      fromPending: null,
    } as const;

    await expect(moveJob(db, id, { ...toExtracting, at: clock.now() })).rejects.toThrow(/lease/);
    const lease = await held(id);
    expect(await moveJob(db, id, { ...toExtracting, at: clock.now(), leaseId: MISSING })).toBe(
      false,
    );
    clock.advance(330_000);
    expect(await moveJob(db, id, { ...toExtracting, at: clock.now(), leaseId: lease })).toBe(false);

    expect(await loadJob(db, id)).toMatchObject({ state: "queued" });
  });

  it("keeps the failed stage and its reason on a failed job, still after Skip, and clears them on Retry", async () => {
    const steps: Step[] = [
      ["queued", null],
      ["extracting", "extract"],
      failedAt("extract", "The model declined this post."),
    ];
    const skipped = await jobIn("uploading", steps);
    const retried = await jobIn("uploading", steps);
    expect(await loadJob(db, skipped)).toMatchObject({
      state: "failed",
      pendingStage: "extract",
      failedStage: "extract",
      failure: "The model declined this post.",
    });

    await moveJob(db, skipped, { from: "failed", to: "closed", pending: null, at: clock.now() });
    await retryJob({ db, clock }, retried);

    expect(await loadJob(db, skipped)).toMatchObject({
      state: "closed",
      failedStage: "extract",
      failure: "The model declined this post.",
    });
    expect(await loadJob(db, retried)).toMatchObject({ failedStage: null, failure: null });
  });

  it("moves a running job only as the runner names the stage it leaves, and only while that stage is pending", async () => {
    const id = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["checking", "eligibility"],
      ["drafting", "draft"],
    ]);
    const leaseId = await held(id);
    const toJudging = { from: "drafting", to: "judging", pending: "judge", leaseId } as const;

    await expect(moveJob(db, id, { ...toJudging, at: clock.now() })).rejects.toThrow(/leaves/);
    expect(
      await moveJob(db, id, { ...toJudging, at: clock.now(), fromPending: "draft_answers" }),
    ).toBe(false);
    expect(await moveJob(db, id, { ...toJudging, at: clock.now(), fromPending: "draft" })).toBe(
      true,
    );
  });

  it("compares the time a job last changed state to the millisecond, as JavaScript reads it", async () => {
    const id = await jobIn("uploading");
    // Postgres keeps microseconds, which a JavaScript date cannot hold.
    await db.query(
      "update {{schema}}.jobs set state_changed_at = '2026-10-06 08:00:00.123456+00' where id = $1",
      [id],
    );
    const read = (await loadJob(db, id))!.stateChangedAt;

    expect(
      await moveJob(db, id, {
        from: "uploading",
        to: "upload_failed",
        pending: null,
        at: clock.now(),
        ifChangedAt: read,
      }),
    ).toBe(true);
  });

  it("resumes a failed job only at the stage it failed at", async () => {
    const id = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["checking", "eligibility"],
      ["drafting", "draft"],
      ["judging", "judge"],
      failedAt("judge"),
    ]);

    expect(
      await moveJob(db, id, {
        from: "failed",
        to: "extracting",
        pending: "extract",
        at: clock.now(),
      }),
    ).toBe(false);
    expect(await loadJob(db, id)).toMatchObject({ state: "failed", pendingStage: "judge" });
  });

  it("moves only a job still as its caller last read it", async () => {
    const id = await jobIn("uploading");
    const read = (await loadJob(db, id))!.stateChangedAt;
    const move = { from: "uploading", to: "upload_failed", pending: null } as const;

    expect(
      await moveJob(db, id, {
        ...move,
        at: clock.now(),
        ifChangedAt: new Date(read.getTime() - 1),
      }),
    ).toBe(false);
    expect(await moveJob(db, id, { ...move, at: clock.now(), ifChangedAt: read })).toBe(true);
  });
});

describe("retryJob", () => {
  it("resumes the stage that failed in its running state, in a new round of attempts", async () => {
    const id = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["checking", "eligibility"],
      ["drafting", "draft_answers"],
      ["failed", "draft_answers", { stage: "address_read", reason: "The second read timed out." }],
    ]);

    expect(await retryJob({ db, clock }, id)).toEqual({ ok: true });

    expect(await loadJob(db, id)).toMatchObject({
      state: "drafting",
      pendingStage: "draft_answers",
      retryRound: 1,
      failedStage: null,
      failure: null,
    });
  });

  it("refuses a job that has not failed, and one that does not exist", async () => {
    const id = await jobIn("uploading", [["queued", null]]);

    expect(await retryJob({ db, clock }, id)).toEqual({ ok: false, reason: "not-failed" });
    for (const missing of [MISSING, "not-a-uuid"]) {
      expect(await retryJob({ db, clock }, missing)).toEqual({ ok: false, reason: "not-found" });
    }
  });
});

describe("skipJob", () => {
  it("closes failed, upload_failed and stopped jobs, and those waiting on a decision Skip always closes", async () => {
    const failed = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      failedAt("extract"),
    ]);
    const uploadFailed = await jobIn("uploading", [["upload_failed", null]]);
    const stopped = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["stopped", null],
    ]);
    const deciding = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["checking", "eligibility"],
      ["needs_eligibility_decision", null],
    ]);
    const kitType = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["checking", "eligibility"],
      ["needs_kit_type", null],
    ]);

    for (const id of [failed, uploadFailed, stopped, deciding, kitType]) {
      expect(await skipJob({ db, clock }, id)).toEqual({ ok: true });
      expect(await loadJob(db, id)).toMatchObject({ state: "closed", pendingStage: null });
    }
  });

  it("refuses every other state, among them a role pick, whose Skip extraction decides", async () => {
    const uploading = await jobIn("uploading");
    const running = await jobIn("uploading", [["queued", null]]);
    const manual = await jobIn("manual_run");
    const rolePick = await jobIn("uploading", [
      ["queued", null],
      ["extracting", "extract"],
      ["needs_role_pick", null],
    ]);

    for (const id of [uploading, running, manual, rolePick]) {
      expect(await skipJob({ db, clock }, id)).toEqual({ ok: false, reason: "not-skippable" });
    }
    expect(await skipJob({ db, clock }, "not-a-uuid")).toEqual({ ok: false, reason: "not-found" });
    expect(await loadJob(db, running)).toMatchObject({ state: "queued" });
  });
});

describe("upload timeout", () => {
  it("moves a job still uploading 15 minutes after it began to upload_failed when its status is read, as of that deadline", async () => {
    const id = await jobIn("uploading");
    const deadline = new Date(clock.now().getTime() + 15 * MINUTE);

    clock.advance(15 * MINUTE - 1);
    expect(await jobStatus({ db, clock }, id)).toMatchObject({ state: "uploading" });

    clock.advance(40 * MINUTE);
    expect(await jobStatus({ db, clock }, id)).toMatchObject({ state: "upload_failed" });
    expect((await changes(id)).at(-1)).toEqual({
      from_state: "uploading",
      to_state: "upload_failed",
      at: deadline,
    });
  });

  it("counts the 15 minutes afresh after Upload again", async () => {
    const id = await jobIn("uploading", [["upload_failed", null]]);
    clock.advance(60 * MINUTE);
    await moveJob(db, id, {
      from: "upload_failed",
      to: "uploading",
      pending: null,
      at: clock.now(),
    });

    clock.advance(10 * MINUTE);
    expect(await jobStatus({ db, clock }, id)).toMatchObject({ state: "uploading" });
  });

  it("expires every such job in the daily backstop, and only those", async () => {
    const stale = await jobIn("uploading");
    const other = await jobIn("uploading", [["queued", null]]);
    clock.advance(16 * MINUTE);
    const fresh = await jobIn("uploading");

    expect(await expireUploads(db, clock.now())).toBe(1);

    expect(await loadJob(db, stale)).toMatchObject({ state: "upload_failed" });
    expect(await loadJob(db, other)).toMatchObject({ state: "queued" });
    expect(await loadJob(db, fresh)).toMatchObject({ state: "uploading" });
  });

  it("never fails an upload that began again after the expiry read the job", async () => {
    const id = await jobIn("uploading");
    clock.advance(20 * MINUTE);
    // Between the expiry's read and its move, another read expires the job and the owner uploads again.
    const racing: Db = {
      schema: db.schema,
      exec: (sql) => db.exec(sql),
      tx: (fn) => db.tx(fn),
      async query(sql, params) {
        const result = await db.query(sql, params);
        if (sql.includes("where state = 'uploading'")) {
          await expireUploads(db, clock.now(), id);
          await moveJob(db, id, {
            from: "upload_failed",
            to: "uploading",
            pending: null,
            at: clock.now(),
          });
        }
        return result as never;
      },
    };

    expect(await expireUploads(racing, clock.now(), id)).toBe(0);

    expect(await loadJob(db, id)).toMatchObject({
      state: "uploading",
      stateChangedAt: clock.now(),
    });
  });

  it("reads nothing for an ID that cannot name a job", async () => {
    expect(await loadJob(db, "not-a-uuid")).toBeNull();
    expect(await jobStatus({ db, clock }, "not-a-uuid")).toBeNull();
  });
});
