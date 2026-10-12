import type { Clock, Db } from "@/core/ports";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";
import { describeThrown, storableText } from "@/lib/storableText";

import { claimOne } from "./claim";
import { type Job, loadJob, moveJob } from "./jobs";
import {
  checkMove,
  isJobState,
  isStageName,
  JOB_STATES,
  type JobState,
  kindOf,
  type StageName,
} from "./jobStates";
import { abandonStartedCalls, MODEL_CALL_LIMITS } from "./models";

/**
 * The pipeline runner (platform spec B9). Modules register stages; the runner
 * owns their order, the job's state and the bookkeeping, never the stages'
 * logic. A request that finds a running job unclaimed claims its lease, and
 * the runner then runs stages in order inside that one invocation for as
 * long as they fit; the next poll resumes whatever is left. No request ever
 * calls the app's own URL.
 *
 * On Vercel an invocation is killed at 300 seconds, before its lease lapses
 * at 330. Where nothing kills it (`next dev`, a server of one's own), a stage
 * still running when its lease lapses can overlap the next claim's run of it;
 * from then on the old invocation records nothing and moves nothing.
 */

export interface StageOutput {
  output: unknown;
  outputHash: string;
}

export interface StageContext {
  /** The job as it stood when the step began. */
  readonly job: Job;
  /** A stage's current output: its latest finished or reused run. */
  outputOf(stage: StageName): Promise<StageOutput | null>;
}

export type StageResult =
  | { ok: true; output: unknown }
  /** `retry`: whether starting the stage again may succeed (a timeout) or not (a refusal). */
  | { ok: false; reason: string; retry: boolean };

export interface Transition {
  state: JobState;
  pending: StageName | null;
}

export interface StageDefinition {
  /** Whether it calls a model; such a stage starts only while its worst case still fits. */
  readonly callsModel: boolean;
  /**
   * What the stage reads, as JSON. Its hash decides whether an earlier
   * output can be reused, so it covers exactly what B9's table lists.
   */
  input(ctx: StageContext): Promise<unknown> | unknown;
  run(ctx: StageContext, input: unknown): Promise<StageResult>;
  /** For a stage that can be pending: where the job goes with this output. */
  next?(ctx: StageContext, output: unknown): Promise<Transition> | Transition;
  /** For a stage that can be pending: the stages that run beside it. */
  alongside?(ctx: StageContext): Promise<readonly StageName[]> | readonly StageName[];
}

export type Pipeline = Partial<Record<StageName, StageDefinition>>;

export interface RunnerLimits {
  /** Longer than Vercel's 300-second limit, so a killed invocation's lease always lapses. */
  leaseMs: number;
  /** How much of an invocation the runner uses, counted from the request's start. */
  invocationMs: number;
  /** A model stage's worst case (B4). */
  modelStageMs: number;
}

export const RUNNER_LIMITS: RunnerLimits = {
  leaseMs: 330_000,
  invocationMs: 285_000,
  // The wrapper counts the input first, then gives the attempts and one retry's wait a deadline.
  modelStageMs:
    MODEL_CALL_LIMITS.countMs + MODEL_CALL_LIMITS.totalMs + MODEL_CALL_LIMITS.maxRetryWaitMs,
};

// A stage started this many times since it last finished fails the job; Retry starts afresh.
const MAX_UNFINISHED_STARTS = 3;

export interface RunnerDeps {
  db: Db;
  clock: Clock;
  pipeline: Pipeline;
  limits?: Partial<RunnerLimits>;
}

export interface Lease {
  id: string;
  jobId: string;
  claimedAt: Date;
  expiresAt: Date;
}

/** How an invocation ended: the job left the running states, time ran out, or the lease was lost. */
export type RunEnd = "settled" | "out-of-time" | "lease-lost";

const RUNNING_STATES = JOB_STATES.filter((state) => kindOf(state) === "running");

const NOT_AVAILABLE = "This step is not available yet.";
const BROKE = "Something went wrong in this step.";
const NOWHERE = "This step chose a next step the pipeline does not allow.";
const STARTED_TOO_OFTEN = "This step was started three times without finishing.";

function limitsOf(deps: RunnerDeps): RunnerLimits {
  return { ...RUNNER_LIMITS, ...deps.limits };
}

/**
 * Claims a running job's lease with one conditional update, which succeeds
 * only while no unexpired lease exists, and records the claim. What a killed
 * invocation left started (stage runs and model calls) is marked abandoned
 * here, since its lease has lapsed; such a run ended by its lease's release
 * or expiry at the latest. Returns null when the job is not running or
 * another invocation holds it. `requestedAt` is when the request that
 * claims reached the server: the lease is recorded from then, so the
 * request's own time is never counted as a gap no page polled.
 */
export async function claimJob(
  deps: RunnerDeps,
  jobId: string,
  opts: { requestedAt?: Date } = {},
): Promise<Lease | null> {
  const now = deps.clock.now();
  const claimedAt = opts.requestedAt ?? now;
  const expiresAt = new Date(now.getTime() + limitsOf(deps).leaseMs);
  return deps.db.tx(async (tx) => {
    const claimed = await claimOne<{ lease_id: string }>(
      tx,
      `update {{schema}}.jobs set lease_id = gen_random_uuid(), lease_expires_at = $2
        where id = $1 and state = any($4::text[])
          and (lease_expires_at is null or lease_expires_at <= $3)
        returning lease_id`,
      [jobId, expiresAt, now, RUNNING_STATES],
    );
    if (!claimed) return null;
    await tx.query(
      `insert into {{schema}}.job_leases (id, job_id, claimed_at, expires_at)
       values ($1, $2, $3, $4)`,
      [claimed.lease_id, jobId, claimedAt, expiresAt],
    );
    await tx.query(
      `update {{schema}}.job_stage_runs as run
          set outcome = 'abandoned',
              ended_at = least($2, coalesce(lease.released_at, lease.expires_at))
         from {{schema}}.job_leases as lease
        where run.job_id = $1 and run.outcome = 'started' and lease.id = run.lease_id`,
      [jobId, now],
    );
    await abandonStartedCalls(tx, jobId, now);
    return { id: claimed.lease_id, jobId, claimedAt, expiresAt };
  });
}

/**
 * Runs the job's stages in order under the lease until the job leaves the
 * running states, time runs out or the lease is lost, then releases it.
 * `startedAt` is when the request began, which the invocation's time limit
 * counts from; the claim came a little later.
 */
export async function runJob(
  deps: RunnerDeps,
  lease: Lease,
  opts: { startedAt?: Date } = {},
): Promise<RunEnd> {
  const startedAt = opts.startedAt ?? lease.claimedAt;
  try {
    for (;;) {
      const job = await loadJob(deps.db, lease.jobId);
      if (!job) return "lease-lost";
      // Leaving the running states clears the lease, so this comes first.
      if (kindOf(job.state) !== "running") return "settled";
      if (job.leaseId !== lease.id) return "lease-lost";
      const end = await step(deps, lease, startedAt, job);
      if (end) return end;
    }
  } finally {
    await releaseLease(deps, lease);
  }
}

async function releaseLease(deps: RunnerDeps, lease: Lease): Promise<void> {
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    await tx.query(
      `update {{schema}}.jobs set lease_id = null, lease_expires_at = null
        where id = $1 and lease_id = $2`,
      [lease.jobId, lease.id],
    );
    await tx.query(
      `update {{schema}}.job_leases set released_at = least($2, expires_at)
        where id = $1 and released_at is null`,
      [lease.id, now],
    );
  });
}

interface Planned {
  name: StageName;
  def: StageDefinition;
  input: unknown;
  inputHash: string;
  earlier: StageOutput | null;
}

type Ran = { name: StageName; result: StageResult } | "lease-lost";

/**
 * One step: the pending stage and those beside it, each reused when an
 * output for its input exists and run otherwise, all at once; then the
 * pending stage says where the job goes. A stage's own code that throws,
 * or that returns what the runner cannot use, fails the job: it is a bug,
 * and Retry runs it again once fixed. Returns null to go on.
 */
async function step(
  deps: RunnerDeps,
  lease: Lease,
  startedAt: Date,
  job: Job,
): Promise<RunEnd | null> {
  const { db, clock } = deps;
  if (job.state === "queued") {
    return moved(
      await moveJob(db, job.id, {
        from: "queued",
        to: "extracting",
        pending: "extract",
        at: clock.now(),
        leaseId: lease.id,
        fromPending: null,
      }),
    );
  }
  // moveJob gives every running state but queued a pending stage.
  const pending = job.pendingStage;
  if (pending === null) throw new Error(`Job ${job.id} is ${job.state} with no pending stage`);
  // Stages see a copy, so none can change what the runner acts on.
  const ctx = contextFor(db, Object.freeze({ ...job }));
  const main = deps.pipeline[pending];
  if (!main) return failWithRun(deps, lease, job, pending, NOT_AVAILABLE, unregistered(pending));
  // Found before anything runs, so no model call is spent on a step that cannot end.
  if (!main.next) {
    return failWithRun(deps, lease, job, pending, NOWHERE, "The stage names no next step");
  }

  let beside: readonly StageName[];
  try {
    const named: unknown = (await main.alongside?.(ctx)) ?? [];
    if (!Array.isArray(named) || !named.every(isStageName)) {
      throw new TypeError("alongside() did not return a list of stage names");
    }
    beside = named;
  } catch (thrown) {
    return broke(deps, lease, job, pending, null, thrown);
  }
  const planned: Planned[] = [];
  for (const name of new Set([pending, ...beside])) {
    const def = deps.pipeline[name];
    if (!def) return failWithRun(deps, lease, job, name, NOT_AVAILABLE, unregistered(name));
    let input: unknown;
    let inputHash: string;
    try {
      input = await def.input(ctx);
      inputHash = sha256Hex(canonicalJson({ stage: name, input }));
    } catch (thrown) {
      return broke(deps, lease, job, name, null, thrown);
    }
    const earlier = await reusable(db, job.id, name, inputHash);
    planned.push({ name, def, input, inputHash, earlier });
  }
  const toRun = planned.filter((stage) => stage.earlier === null);

  for (const stage of toRun) {
    const unfinished = await unfinishedStarts(db, job, stage.name);
    if (unfinished.count >= MAX_UNFINISHED_STARTS) {
      return fail(deps, lease, job, stage.name, unfinished.lastError ?? STARTED_TOO_OFTEN);
    }
  }

  const limits = limitsOf(deps);
  const elapsed = clock.now().getTime() - startedAt.getTime();
  if (elapsed >= limits.invocationMs) return "out-of-time";
  if (
    toRun.some((stage) => stage.def.callsModel) &&
    elapsed + limits.modelStageMs > limits.invocationMs
  ) {
    return "out-of-time";
  }

  for (const stage of planned) {
    if (!stage.earlier) continue;
    const reused = await insertRun(deps, lease, job, {
      stage: stage.name,
      inputHash: stage.inputHash,
      outcome: "reused",
      output: stage.earlier,
    });
    if (reused === null) return "lease-lost";
  }
  const settled = await Promise.allSettled(
    toRun.map((stage) => runStage(deps, lease, job, ctx, stage)),
  );
  const results: Exclude<Ran, "lease-lost">[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") throw outcome.reason;
    if (outcome.value === "lease-lost") return "lease-lost";
    results.push(outcome.value);
  }

  for (const { name, result } of results) {
    if (!result.ok && !result.retry) return fail(deps, lease, job, name, result.reason);
  }
  const failed = results.filter(({ result }) => !result.ok);
  if (failed.length > 0) {
    // Starting it again comes next, unless it has had its starts.
    for (const { name } of failed) {
      const unfinished = await unfinishedStarts(db, job, name);
      if (unfinished.count >= MAX_UNFINISHED_STARTS) {
        return fail(deps, lease, job, name, unfinished.lastError ?? STARTED_TOO_OFTEN);
      }
    }
    return null;
  }

  // The output as it is stored, whether the stage ran now or was reused.
  const ran = results.find(({ name }) => name === pending);
  const output = ran?.result.ok ? ran.result.output : planned[0]!.earlier?.output;
  let next: Transition;
  try {
    const chosen: unknown = await main.next(ctx, output);
    if (
      !isRecord(chosen) ||
      !isJobState(chosen.state) ||
      !(chosen.pending === null || isStageName(chosen.pending))
    ) {
      throw new TypeError("next() did not return a state and a pending stage");
    }
    next = { state: chosen.state, pending: chosen.pending };
  } catch (thrown) {
    return broke(deps, lease, job, pending, planned[0]!.inputHash, thrown);
  }
  // Only the runner sends a job to failed, with the stage and reason it records.
  if (next.state === "failed" || !checkMove(job.state, next.state, next.pending, pending).ok) {
    const chose = `next() chose ${next.state} with ${next.pending ?? "no stage"} pending, which the table does not allow after ${pending}`;
    return failWithRun(deps, lease, job, pending, NOWHERE, chose, planned[0]!.inputHash);
  }
  return moved(
    await moveJob(db, job.id, {
      from: job.state,
      to: next.state,
      pending: next.pending,
      at: clock.now(),
      leaseId: lease.id,
      fromPending: pending,
    }),
  );
}

function moved(done: boolean): RunEnd | null {
  return done ? null : "lease-lost";
}

/** Fails the job, keeping its pending stage for Retry and naming the stage that failed. */
async function fail(
  deps: RunnerDeps,
  lease: Lease,
  job: Job,
  stage: StageName,
  reason: string,
): Promise<RunEnd | null> {
  return moved(
    await moveJob(deps.db, job.id, {
      from: job.state,
      to: "failed",
      pending: job.pendingStage,
      at: deps.clock.now(),
      failure: { stage, reason: storableText(reason) },
      leaseId: lease.id,
      fromPending: job.pendingStage,
    }),
  );
}

/** Records a stage's own code failing outside its run, then fails the job. */
async function broke(
  deps: RunnerDeps,
  lease: Lease,
  job: Job,
  stage: StageName,
  inputHash: string | null,
  thrown: unknown,
): Promise<RunEnd | null> {
  return failWithRun(deps, lease, job, stage, BROKE, describeThrown(thrown), inputHash);
}

/** Fails the job with the reason the page shows, and records the cause on a run of the stage. */
async function failWithRun(
  deps: RunnerDeps,
  lease: Lease,
  job: Job,
  stage: StageName,
  reason: string,
  error: string,
  inputHash: string | null = null,
): Promise<RunEnd | null> {
  const recorded = await insertRun(deps, lease, job, {
    stage,
    inputHash,
    outcome: "failed",
    error,
  });
  if (recorded === null) return "lease-lost";
  return fail(deps, lease, job, stage, reason);
}

function unregistered(stage: StageName): string {
  return `No stage named ${stage} is registered in the pipeline`;
}

function contextFor(db: Db, job: Job): StageContext {
  return {
    job,
    async outputOf(stage) {
      const { rows } = await db.query<{ output: unknown; output_hash: string }>(
        `select output, output_hash from {{schema}}.job_stage_runs
          where job_id = $1 and stage = $2 and outcome in ('ok', 'reused')
          order by id desc limit 1`,
        [job.id, stage],
      );
      return rows[0] ? { output: rows[0].output, outputHash: rows[0].output_hash } : null;
    },
  };
}

/** An output the stage already gave for this input, in this job. */
async function reusable(
  db: Db,
  jobId: string,
  stage: StageName,
  inputHash: string,
): Promise<StageOutput | null> {
  const { rows } = await db.query<{ output: unknown; output_hash: string }>(
    `select output, output_hash from {{schema}}.job_stage_runs
      where job_id = $1 and stage = $2 and input_hash = $3 and outcome in ('ok', 'reused')
      order by id desc limit 1`,
    [jobId, stage, inputHash],
  );
  return rows[0] ? { output: rows[0].output, outputHash: rows[0].output_hash } : null;
}

// The stage's starts in the job's round since it last finished that did not finish themselves.
const UNFINISHED = `
  from {{schema}}.job_stage_runs as prior
 where prior.job_id = $1 and prior.stage = $2 and prior.round = $3
   and prior.outcome in ('started', 'failed', 'abandoned')
   and prior.id > coalesce(
     (select max(done.id) from {{schema}}.job_stage_runs as done
       where done.job_id = $1 and done.stage = $2 and done.outcome = 'ok'),
     0)`;

/** How often the stage was started without finishing since it last finished, and the latest error. */
async function unfinishedStarts(
  db: Db,
  job: Job,
  stage: StageName,
): Promise<{ count: number; lastError: string | null }> {
  const { rows } = await db.query<{ count: number; last_error: string | null }>(
    `select count(*)::int as count,
            (array_agg(prior.error order by prior.id desc))[1] as last_error
     ${UNFINISHED}`,
    [job.id, stage, job.retryRound],
  );
  return { count: rows[0]?.count ?? 0, lastError: rows[0]?.last_error ?? null };
}

/**
 * Inserts one run, only while the lease is live, so an invocation that
 * outlived its lease records nothing more. One statement locks the job's
 * row, checks the lease and inserts the run, so a claim waits for the
 * insert and then finds the run to abandon. A start's attempt number
 * counts the unfinished starts before it (a reuse is not a finish, and has
 * no attempt number). Returns the run's ID, or null when the lease is gone.
 */
async function insertRun(
  deps: RunnerDeps,
  lease: Lease,
  job: Job,
  run: {
    stage: StageName;
    inputHash: string | null;
    outcome: "started" | "failed" | "reused";
    output?: StageOutput;
    error?: string;
  },
): Promise<string | null> {
  const now = deps.clock.now();
  const { rows } = await deps.db.query<{ id: string }>(
    `with live as (
       select id from {{schema}}.jobs
        where id = $1 and lease_id = $4 and lease_expires_at > $11
        for update
     )
     insert into {{schema}}.job_stage_runs
       (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash,
        retryable, error, started_at, ended_at)
     select live.id, $4::uuid, $2::text, $3::int,
            case when $6::text = 'reused' then null else (select count(*) + 1 ${UNFINISHED}) end,
            $5::text, $6::text, $7::jsonb, $8::text, $9::boolean, $10::text, $11::timestamptz,
            $12::timestamptz
       from live
     returning id`,
    [
      job.id,
      run.stage,
      job.retryRound,
      lease.id,
      run.inputHash,
      run.outcome,
      run.output ? canonicalJson(run.output.output ?? null) : null,
      run.output?.outputHash ?? null,
      run.outcome === "failed" ? false : null,
      run.error ?? null,
      now,
      run.outcome === "started" ? null : now,
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * Starts one stage: its row is inserted as started first, so a killed
 * invocation leaves a trace, and finished only while still started, so an
 * invocation that outlived its lease writes nothing over the next one's
 * bookkeeping and learns it lost the job. A stage that throws, returns what
 * is not a stage result, or gives an output that cannot be stored, fails the
 * job with a plain reason, and its run keeps the error. A stage's output is
 * passed on as it is stored.
 */
async function runStage(
  deps: RunnerDeps,
  lease: Lease,
  job: Job,
  ctx: StageContext,
  stage: Planned,
): Promise<Ran> {
  const { db, clock } = deps;
  const runId = await insertRun(deps, lease, job, {
    stage: stage.name,
    inputHash: stage.inputHash,
    outcome: "started",
  });
  if (runId === null) return "lease-lost";
  const broken = async (thrown: unknown): Promise<Ran> => {
    const closed = await finishFailed(db, runId, {
      retry: false,
      error: describeThrown(thrown),
      at: clock.now(),
    });
    return closed
      ? { name: stage.name, result: { ok: false, reason: BROKE, retry: false } }
      : "lease-lost";
  };
  let result: StageResult;
  try {
    const returned: unknown = await stage.def.run(ctx, stage.input);
    if (!isStageResult(returned)) throw new TypeError("run() did not return a stage result");
    result = returned;
  } catch (thrown) {
    return broken(thrown);
  }
  if (!result.ok) {
    const closed = await finishFailed(db, runId, {
      retry: result.retry,
      error: result.reason,
      at: clock.now(),
    });
    return closed ? { name: stage.name, result } : "lease-lost";
  }
  let stored: unknown;
  try {
    const text = canonicalJson(result.output ?? null);
    const { rows } = await db.query<{ output: unknown }>(
      `update {{schema}}.job_stage_runs
          set outcome = 'ok', output = $2::jsonb, output_hash = $3, ended_at = $4
        where id = $1 and outcome = 'started'
        returning output`,
      [runId, text, sha256Hex(text), clock.now()],
    );
    if (rows.length === 0) return "lease-lost";
    stored = rows[0]!.output;
  } catch (thrown) {
    return broken(thrown);
  }
  return { name: stage.name, result: { ok: true, output: stored } };
}

/** Closes a started run as failed; false when it was no longer started, its lease taken over. */
async function finishFailed(
  db: Db,
  runId: string,
  failure: { retry: boolean; error: string; at: Date },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update {{schema}}.job_stage_runs
        set outcome = 'failed', retryable = $2, error = $3, ended_at = $4
      where id = $1 and outcome = 'started'`,
    [runId, failure.retry, storableText(failure.error), failure.at],
  );
  return rowCount > 0;
}

function isStageResult(value: unknown): value is StageResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  return value.ok === false && typeof value.reason === "string" && typeof value.retry === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
