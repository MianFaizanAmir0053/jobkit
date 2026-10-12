import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import { createJob, loadJob, moveJob, retryJob } from "./jobs";
import type { StageName } from "./jobStates";
import {
  claimJob,
  type Pipeline,
  runJob,
  type RunnerDeps,
  type StageContext,
  type StageDefinition,
  type StageResult,
} from "./runner";
import { loadJobTimes } from "./times";

let db: PgliteDb;
let clock: FakeClock;

/** What the fake stages read, and what they did. */
interface World {
  images: string[];
  confirmed: boolean;
  notAPost: boolean;
  address: string;
  calls: StageName[];
  /** Results a stage gives on its next runs, in turn; then it succeeds. */
  results: Partial<Record<StageName, StageResult[]>>;
  /** How long a stage's run takes on the fake clock. */
  takesMs: Partial<Record<StageName, number>>;
  /** A stage that waits for this before it finishes, standing in for a killed invocation. */
  hang: Partial<Record<StageName, Promise<void>>>;
}

let world: World;

const ok = (output: unknown): StageResult => ({ ok: true, output });

function fake(
  name: StageName,
  def: Omit<StageDefinition, "run">,
  output: unknown,
): StageDefinition {
  return {
    ...def,
    async run() {
      world.calls.push(name);
      clock.advance(world.takesMs[name] ?? 1_000);
      const hang = world.hang[name];
      if (hang) await hang;
      return world.results[name]?.shift() ?? ok(output);
    },
  };
}

const hashOf = async (ctx: StageContext, stage: StageName) =>
  (await ctx.outputOf(stage))?.outputHash ?? null;

function pipeline(): Pipeline {
  return {
    extract: {
      ...fake(
        "extract",
        { callsModel: true, input: () => ({ images: world.images, confirmed: world.confirmed }) },
        null,
      ),
      async run() {
        world.calls.push("extract");
        clock.advance(world.takesMs.extract ?? 1_000);
        const post = !world.notAPost || world.confirmed;
        return world.results.extract?.shift() ?? ok({ post, roles: ["P1"] });
      },
      next: (_ctx, output) =>
        (output as { post: boolean }).post
          ? { state: "checking", pending: "eligibility" }
          : { state: "stopped", pending: null },
    },
    eligibility: {
      ...fake(
        "eligibility",
        { callsModel: false, input: async (ctx) => ({ record: await hashOf(ctx, "extract") }) },
        { verdict: "eligible" },
      ),
      next: () => ({ state: "drafting", pending: "draft" }),
    },
    draft: {
      ...fake(
        "draft",
        { callsModel: true, input: async (ctx) => ({ record: await hashOf(ctx, "extract") }) },
        { text: "Dear Acme," },
      ),
      alongside: () => ["address_read", "address_checks"],
      next: () => ({ state: "judging", pending: "judge" }),
    },
    address_read: fake(
      "address_read",
      { callsModel: true, input: () => ({ crop: world.images[0] }) },
      { read: "jobs@acme.example" },
    ),
    address_checks: fake(
      "address_checks",
      { callsModel: false, input: () => ({ address: world.address }) },
      { blocking: false },
    ),
    judge: {
      ...fake(
        "judge",
        { callsModel: true, input: async (ctx) => ({ draft: await hashOf(ctx, "draft") }) },
        { verdict: "pass" },
      ),
      next: () => ({ state: "kit_ready", pending: null }),
    },
  };
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return { db, clock, pipeline: pipeline(), ...overrides };
}

async function queuedJob(): Promise<string> {
  const id = await createJob(db, {
    state: "uploading",
    receivedAt: clock.now(),
    clientElapsedMs: 0,
  });
  await moveJob(db, id, { from: "uploading", to: "queued", pending: null, at: clock.now() });
  return id;
}

/** One poll's worth: claim the job and run what one invocation runs. */
async function advance(id: string, runner: RunnerDeps = deps()) {
  const lease = await claimJob(runner, id);
  if (!lease) throw new Error("The job could not be claimed");
  return runJob(runner, lease);
}

async function readyJob(): Promise<string> {
  const id = await queuedJob();
  expect(await advance(id)).toBe("settled");
  expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
  world.calls = [];
  return id;
}

async function states(id: string): Promise<string[]> {
  const { rows } = await db.query<{ to_state: string }>(
    "select to_state from {{schema}}.job_state_changes where job_id = $1 order by id",
    [id],
  );
  return rows.map((row) => row.to_state);
}

async function outcomes(id: string, stage: StageName): Promise<string[]> {
  const { rows } = await db.query<{ outcome: string }>(
    "select outcome from {{schema}}.job_stage_runs where job_id = $1 and stage = $2 order by id",
    [id, stage],
  );
  return rows.map((row) => row.outcome);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs`,
  );
  clock = fakeClock();
  world = {
    images: ["img-1", "img-2"],
    confirmed: false,
    notAPost: false,
    address: "jobs@acme.example",
    calls: [],
    results: {},
    takesMs: {},
    hang: {},
  };
});

describe("claimJob", () => {
  it("claims only a running job, refuses a second claim while the lease is live, and takes a lapsed one", async () => {
    const id = await createJob(db, {
      state: "uploading",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    expect(await claimJob(deps(), id)).toBeNull();

    await moveJob(db, id, { from: "uploading", to: "queued", pending: null, at: clock.now() });
    const first = await claimJob(deps(), id);
    expect(first).not.toBeNull();
    expect(await claimJob(deps(), id)).toBeNull();

    clock.advance(330_000 - 1);
    expect(await claimJob(deps(), id)).toBeNull();
    clock.advance(1);
    const second = await claimJob(deps(), id);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });
});

describe("runJob", () => {
  it("runs the stages in order inside one claimed invocation, with the address stages beside draft", async () => {
    const id = await queuedJob();

    expect(await advance(id)).toBe("settled");

    expect(world.calls.slice(0, 2)).toEqual(["extract", "eligibility"]);
    expect(world.calls.slice(2, 5).sort()).toEqual(["address_checks", "address_read", "draft"]);
    expect(world.calls.slice(5)).toEqual(["judge"]);
    expect(await states(id)).toEqual([
      "uploading",
      "queued",
      "extracting",
      "checking",
      "drafting",
      "judging",
      "kit_ready",
    ]);
    expect(await loadJob(db, id)).toMatchObject({
      state: "kit_ready",
      pendingStage: null,
      leaseId: null,
    });
    // A ready job never advances by itself.
    expect(await claimJob(deps(), id)).toBeNull();
  });

  it("reuses every output whose input is unchanged, so an edited address re-runs only address_checks", async () => {
    const id = await readyJob();
    world.address = "hr@acme.example";
    await moveJob(db, id, { from: "kit_ready", to: "drafting", pending: "draft", at: clock.now() });

    expect(await advance(id)).toBe("settled");

    expect(world.calls).toEqual(["address_checks"]);
    expect(await outcomes(id, "draft")).toEqual(["ok", "reused"]);
    expect(await outcomes(id, "judge")).toEqual(["ok", "reused"]);
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
  });

  it("re-runs only what reads new screenshots, and calls nothing when no input changed", async () => {
    const id = await readyJob();
    await moveJob(db, id, {
      from: "kit_ready",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
    });
    expect(await advance(id)).toBe("settled");
    expect(world.calls).toEqual([]);

    world.images = [...world.images, "img-3"];
    await moveJob(db, id, {
      from: "kit_ready",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
    });
    expect(await advance(id)).toBe("settled");
    // extract's answer is the same, so what reads it is reused; the crop comes from the first image.
    expect(world.calls).toEqual(["extract"]);
  });

  it("re-runs extract when the owner confirms a post it stopped as not a job post", async () => {
    world.notAPost = true;
    const id = await queuedJob();
    expect(await advance(id)).toBe("settled");
    expect(await loadJob(db, id)).toMatchObject({ state: "stopped", pendingStage: null });

    world.confirmed = true;
    await moveJob(db, id, {
      from: "stopped",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
    });
    expect(await advance(id)).toBe("settled");

    expect(world.calls.filter((stage) => stage === "extract")).toHaveLength(2);
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
  });

  it("fails a stage started three times without finishing, and Retry resumes it in a new round", async () => {
    const timedOut: StageResult = { ok: false, retry: true, reason: "The model took too long." };
    world.results.judge = [timedOut, timedOut, timedOut];
    const id = await queuedJob();

    expect(await advance(id)).toBe("settled");

    expect(world.calls.filter((stage) => stage === "judge")).toHaveLength(3);
    expect(await outcomes(id, "judge")).toEqual(["failed", "failed", "failed"]);
    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      pendingStage: "judge",
      failedStage: "judge",
      failure: "The model took too long.",
    });

    expect(await retryJob({ db, clock }, id)).toEqual({ ok: true });
    expect(await advance(id)).toBe("settled");
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready", retryRound: 1 });
  });

  it("starts a retried stage again in the same invocation, and keeps going once it succeeds", async () => {
    world.results.extract = [{ ok: false, retry: true, reason: "The connection dropped." }];
    const id = await queuedJob();

    expect(await advance(id)).toBe("settled");

    expect(await outcomes(id, "extract")).toEqual(["failed", "ok"]);
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
  });

  it("fails the job at once on a failure that may not be retried, such as a refusal", async () => {
    world.results.extract = [{ ok: false, retry: false, reason: "The model declined this post." }];
    const id = await queuedJob();

    expect(await advance(id)).toBe("settled");

    expect(world.calls).toEqual(["extract"]);
    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      pendingStage: "extract",
      failedStage: "extract",
      failure: "The model declined this post.",
    });
  });

  it("starts a model stage only while its worst case still fits the invocation; the next claim resumes", async () => {
    world.takesMs.extract = 80_000;
    const id = await queuedJob();

    expect(await advance(id)).toBe("out-of-time");

    // eligibility calls no model, so it still runs.
    expect(world.calls).toEqual(["extract", "eligibility"]);
    expect(await loadJob(db, id)).toMatchObject({
      state: "drafting",
      pendingStage: "draft",
      leaseId: null,
    });

    expect(await advance(id)).toBe("settled");
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
  });

  it("marks what a killed invocation left started as abandoned when the job is next claimed", async () => {
    let finish!: () => void;
    world.hang.draft = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const id = await queuedJob();
    const first = await claimJob(deps(), id);
    const killed = runJob(deps(), first!);
    await vi.waitFor(() => expect(world.calls).toContain("draft"));
    await db.query(
      `insert into {{schema}}.model_calls (job_id, stage, attempt, provider, requested_model, started_at, outcome)
       values ($1, 'draft', 1, 'anthropic', 'claude-opus-5-5', $2, 'started')`,
      [id, clock.now()],
    );

    clock.advance(330_000);
    delete world.hang.draft;
    const second = await claimJob(deps(), id);

    expect(await outcomes(id, "draft")).toEqual(["abandoned"]);
    const { rows } = await db.query<{ outcome: string }>(
      "select outcome from {{schema}}.model_calls where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ outcome: "abandoned" }]);

    expect(await runJob(deps(), second!)).toBe("settled");
    finish();
    // The killed invocation, had it lived on, may write nothing more.
    expect(await killed).toBe("lease-lost");
    expect(await outcomes(id, "draft")).toEqual(["abandoned", "ok"]);
    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
  });

  it("fails the job when its pending stage is not registered", async () => {
    const withoutExtract = pipeline();
    delete withoutExtract.extract;
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: withoutExtract }))).toBe("settled");

    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      failedStage: "extract",
      failure: "This step is not available yet.",
    });
  });

  it("fails the job when a stage throws, keeping the error on the stage's run", async () => {
    const broken = pipeline();
    broken.eligibility = {
      ...broken.eligibility!,
      run: async () => {
        throw new Error("region table missing");
      },
    };
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: broken }))).toBe("settled");

    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      failedStage: "eligibility",
      failure: "Something went wrong in this step.",
    });
    const { rows } = await db.query<{ error: string }>(
      "select error from {{schema}}.job_stage_runs where job_id = $1 and stage = 'eligibility'",
      [id],
    );
    expect(rows).toEqual([{ error: "Error: region table missing" }]);
  });

  it("refuses a move outside the table that a stage asks for, failing the job instead", async () => {
    const wrong = pipeline();
    wrong.extract = { ...wrong.extract!, next: () => ({ state: "kit_ready", pending: null }) };
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: wrong }))).toBe("settled");

    expect(await loadJob(db, id)).toMatchObject({ state: "failed", failedStage: "extract" });
    expect(await states(id)).not.toContain("kit_ready");
    const { rows } = await db.query<{ error: string }>(
      "select error from {{schema}}.job_stage_runs where job_id = $1 and outcome = 'failed'",
      [id],
    );
    expect(rows).toEqual([{ error: expect.stringContaining("kit_ready") }]);
  });
});

describe("runJob, the hard cases", () => {
  it("counts only the starts since a stage last finished, so a stage that recovers each time never fails", async () => {
    const dropped: StageResult = { ok: false, retry: true, reason: "The connection dropped." };
    world.results.extract = [dropped];
    const id = await queuedJob();
    expect(await advance(id)).toBe("settled");
    for (const image of ["img-3", "img-4"]) {
      world.images = [...world.images, image];
      world.results.extract = [dropped];
      await moveJob(db, id, {
        from: "kit_ready",
        to: "extracting",
        pending: "extract",
        at: clock.now(),
      });
      expect(await advance(id)).toBe("settled");
    }

    expect(await loadJob(db, id)).toMatchObject({ state: "kit_ready" });
    const { rows } = await db.query<{ outcome: string; attempt: number }>(
      `select outcome, attempt from {{schema}}.job_stage_runs
        where job_id = $1 and stage = 'extract' order by id`,
      [id],
    );
    expect(rows).toEqual([
      { outcome: "failed", attempt: 1 },
      { outcome: "ok", attempt: 2 },
      { outcome: "failed", attempt: 1 },
      { outcome: "ok", attempt: 2 },
      { outcome: "failed", attempt: 1 },
      { outcome: "ok", attempt: 2 },
    ]);
  });

  it("fails the job, rather than leaving it running, when a stage's input, alongside or next throws", async () => {
    const cases = [
      ["eligibility", "input"],
      ["draft", "alongside"],
      ["extract", "next"],
    ] as const;
    for (const [stage, hook] of cases) {
      const broken = pipeline();
      broken[stage] = {
        ...broken[stage]!,
        [hook]: () => {
          throw new Error(`${hook} broke`);
        },
      };
      const id = await queuedJob();

      expect(await advance(id, deps({ pipeline: broken }))).toBe("settled");

      expect(await loadJob(db, id)).toMatchObject({
        state: "failed",
        failedStage: stage,
        failure: "Something went wrong in this step.",
      });
      const { rows } = await db.query<{ error: string }>(
        `select error from {{schema}}.job_stage_runs
          where job_id = $1 and stage = $2 and outcome = 'failed'`,
        [id, stage],
      );
      expect(rows).toEqual([{ error: `Error: ${hook} broke` }]);
    }
  });

  it("fails the job when a stage names failed as its next state, which only the runner chooses", async () => {
    const wrong = pipeline();
    wrong.extract = { ...wrong.extract!, next: () => ({ state: "failed", pending: "extract" }) };
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: wrong }))).toBe("settled");

    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      failedStage: "extract",
      failure: "This step chose a next step the pipeline does not allow.",
    });
  });

  it("records nothing more once its lease has lapsed, though no other invocation has claimed the job", async () => {
    const stalled = pipeline();
    // A stall while eligibility reads its input outlasts the lease.
    stalled.eligibility = {
      ...stalled.eligibility!,
      input: () => {
        clock.advance(11_000);
        return {};
      },
    };
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: stalled, limits: { leaseMs: 10_000 } }))).toBe(
      "lease-lost",
    );

    expect(await outcomes(id, "eligibility")).toEqual([]);
    expect(await loadJob(db, id)).toMatchObject({ state: "checking" });
  });

  it("counts the invocation's time from its start, before the claim, and a model stage's worst case as the wrapper's", async () => {
    const id = await queuedJob();
    const lease = await claimJob(deps(), id);

    // The request spent 61 seconds before its claim: 61 + 225 is past 285.
    const startedAt = new Date(clock.now().getTime() - 61_000);
    expect(await runJob(deps(), lease!, { startedAt })).toBe("out-of-time");
    expect(world.calls).toEqual([]);

    // At 60 seconds extract just fits; the drafting group after it no longer does.
    const again = await claimJob(deps(), id);
    const later = new Date(clock.now().getTime() - 60_000);
    expect(await runJob(deps(), again!, { startedAt: later })).toBe("out-of-time");
    expect(world.calls).toEqual(["extract", "eligibility"]);
  });

  it("fails the job, with the run closed, when a stage's output cannot be stored", async () => {
    // Postgres refuses a NUL character in jsonb, and JSON has no BigInt.
    for (const output of [{ note: `a${String.fromCharCode(0)}b` }, { count: BigInt(10) }]) {
      world.results.eligibility = [ok(output)];
      const id = await queuedJob();

      expect(await advance(id)).toBe("settled");

      expect(await loadJob(db, id)).toMatchObject({ state: "failed", failedStage: "eligibility" });
      expect(await outcomes(id, "eligibility")).toEqual(["failed"]);
    }
  });

  it("ends a run its released lease left started at the release, not at the next claim", async () => {
    const id = await queuedJob();
    const lease = await claimJob(deps(), id);
    const released = new Date(clock.now().getTime() + 5_000);
    await db.query(
      `insert into {{schema}}.job_stage_runs
         (job_id, lease_id, stage, round, attempt, input_hash, outcome, started_at)
       values ($1, $2, 'extract', 0, 1, 'x', 'started', $3)`,
      [id, lease!.id, clock.now()],
    );
    await db.query(`update {{schema}}.job_leases set released_at = $2 where id = $1`, [
      lease!.id,
      released,
    ]);
    await db.query(
      "update {{schema}}.jobs set lease_id = null, lease_expires_at = null where id = $1",
      [id],
    );
    clock.advance(100_000);

    await claimJob(deps(), id);

    const { rows } = await db.query<{ outcome: string; ended_at: Date }>(
      "select outcome, ended_at from {{schema}}.job_stage_runs where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ outcome: "abandoned", ended_at: released }]);
  });

  it("runs a stage once though a step names it twice", async () => {
    const doubled = pipeline();
    doubled.draft = {
      ...doubled.draft!,
      alongside: () => ["draft", "address_read", "address_checks", "address_read"],
    };
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: doubled }))).toBe("settled");

    expect(world.calls.filter((stage) => stage === "draft")).toHaveLength(1);
    expect(world.calls.filter((stage) => stage === "address_read")).toHaveLength(1);
  });
});

describe("runJob, stages that break their contract", () => {
  it("fails the job when a stage's hook returns what the runner cannot use, instead of throwing", async () => {
    const cases: [StageName, Partial<StageDefinition>][] = [
      ["extract", { next: () => undefined as never }],
      ["extract", { next: () => ({ state: "checking" }) as never }],
      ["draft", { alongside: () => "address_read" as never }],
      ["eligibility", { run: async () => undefined as never }],
      ["eligibility", { run: async () => ({ ok: false, reason: 3, retry: "no" }) as never }],
    ];
    for (const [stage, broken] of cases) {
      const pipe = pipeline();
      pipe[stage] = { ...pipe[stage]!, ...broken };
      const id = await queuedJob();

      expect(await advance(id, deps({ pipeline: pipe }))).toBe("settled");

      expect(await loadJob(db, id)).toMatchObject({
        state: "failed",
        failedStage: stage,
        failure: "Something went wrong in this step.",
      });
      const { rows } = await db.query<{ error: string }>(
        `select error from {{schema}}.job_stage_runs
          where job_id = $1 and stage = $2 and outcome = 'failed'`,
        [id, stage],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.error).toMatch(/TypeError/);
    }
  });

  it("fails a stage that cannot say where the job goes before running it, so nothing is spent", async () => {
    const pipe = pipeline();
    const withoutNext = { ...pipe.eligibility! };
    delete withoutNext.next;
    pipe.eligibility = withoutNext;
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: pipe }))).toBe("settled");

    expect(world.calls).toEqual(["extract"]);
    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      failedStage: "eligibility",
      failure: "This step chose a next step the pipeline does not allow.",
    });
  });

  it("fails the job when a stage names a stage beside it that is not registered", async () => {
    const pipe = pipeline();
    delete pipe.address_read;
    const id = await queuedJob();

    expect(await advance(id, deps({ pipeline: pipe }))).toBe("settled");

    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      failedStage: "address_read",
      failure: "This step is not available yet.",
    });
    const { rows } = await db.query<{ stage: string; error: string }>(
      "select stage, error from {{schema}}.job_stage_runs where job_id = $1 and outcome = 'failed'",
      [id],
    );
    expect(rows).toEqual([{ stage: "address_read", error: expect.stringContaining("registered") }]);
  });

  it("gives next the output as it is stored, whether the stage ran or was reused", async () => {
    const seen: unknown[] = [];
    world.notAPost = true;
    const pipe = pipeline();
    pipe.extract = {
      ...pipe.extract!,
      // jsonb orders keys shortest first, so "b" comes before "aa" once stored.
      run: async () =>
        ok({ post: false, at: new Date("2026-10-06T09:00:00Z"), gone: undefined, aa: 1, b: 2 }),
      next: (_ctx, output) => {
        seen.push(output);
        return { state: "stopped", pending: null };
      },
    };
    const id = await queuedJob();
    expect(await advance(id, deps({ pipeline: pipe }))).toBe("settled");
    await moveJob(db, id, {
      from: "stopped",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
    });
    expect(await advance(id, deps({ pipeline: pipe }))).toBe("settled");

    const { rows } = await db.query<{ output: object }>(
      "select output from {{schema}}.job_stage_runs where job_id = $1 and outcome = 'ok'",
      [id],
    );
    const stored = JSON.stringify(rows[0]!.output);
    expect(seen.map((output) => JSON.stringify(output))).toEqual([stored, stored]);
    expect(seen[0]).toEqual({ at: "2026-10-06T09:00:00.000Z", post: false, aa: 1, b: 2 });
  });

  it("starts no stage once the invocation's time is spent", async () => {
    const id = await queuedJob();
    const lease = await claimJob(deps(), id);

    const startedAt = new Date(clock.now().getTime() - 285_000);
    expect(await runJob(deps(), lease!, { startedAt })).toBe("out-of-time");

    expect(world.calls).toEqual([]);
    expect(await loadJob(db, id)).toMatchObject({ state: "extracting", leaseId: null });
  });

  it("fails a stage at the next step once three killed invocations started it", async () => {
    const id = await queuedJob();
    await advance(id, deps({ pipeline: {} }));
    await db.query(
      "update {{schema}}.jobs set state = 'extracting', pending_stage = 'extract' where id = $1",
      [id],
    );
    for (let kill = 0; kill < 3; kill++) {
      const lease = await claimJob(deps(), id);
      await db.query(
        `insert into {{schema}}.job_stage_runs
           (job_id, lease_id, stage, round, attempt, input_hash, outcome, started_at)
         values ($1, $2, 'extract', 0, 1, 'x', 'started', $3)`,
        [id, lease!.id, clock.now()],
      );
      clock.advance(330_000);
    }

    expect(await advance(id)).toBe("settled");

    expect(world.calls).toEqual([]);
    expect(await loadJob(db, id)).toMatchObject({
      state: "failed",
      failedStage: "extract",
      failure: "This step was started three times without finishing.",
    });
  });

  it("frees a job it parked at once, though the invocation died before releasing its lease", async () => {
    const id = await queuedJob();
    const lease = await claimJob(deps(), id);
    await moveJob(db, id, {
      from: "queued",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
      leaseId: lease!.id,
      fromPending: null,
    });
    await moveJob(db, id, {
      from: "extracting",
      to: "failed",
      pending: "extract",
      at: clock.now(),
      leaseId: lease!.id,
      fromPending: "extract",
      failure: { stage: "extract", reason: "It broke." },
    });

    expect(await retryJob({ db, clock }, id)).toEqual({ ok: true });
    expect(await claimJob(deps(), id)).not.toBeNull();
  });
});

describe("loadJobTimes", () => {
  it("reads a run job's times from its rows: from its start to kit_ready, its stages once each", async () => {
    const id = await createJob(db, {
      state: "uploading",
      receivedAt: clock.now(),
      clientElapsedMs: 3_000,
    });
    const start = clock.now().getTime() - 3_000;
    clock.advance(4_000);
    await moveJob(db, id, { from: "uploading", to: "queued", pending: null, at: clock.now() });
    // A poll 2 seconds later claims it: a normal delay, which counts.
    clock.advance(2_000);
    expect(await advance(id)).toBe("settled");
    const { rows } = await db.query<{ at: Date }>(
      "select at from {{schema}}.job_state_changes where job_id = $1 and to_state = 'kit_ready'",
      [id],
    );

    const times = await loadJobTimes(db, id);

    expect(times).toMatchObject({ machineMs: rows[0]!.at.getTime() - start, pausedMs: 0 });
    expect(times!.processingMs).toBeGreaterThan(0);
    expect(times!.processingMs).toBeLessThan(times!.machineMs);
    expect(await loadJobTimes(db, await queuedJob())).toBeNull();
    expect(await loadJobTimes(db, "not-a-uuid")).toBeNull();
  });
});
