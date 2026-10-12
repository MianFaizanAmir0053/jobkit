import type { Clock, Db } from "@/core/ports";

import { isUuid } from "@/lib/uuid";

import { claimOne } from "./claim";
import {
  checkMove,
  JOB_STATES,
  type JobState,
  kindOf,
  type StageName,
  stateOfStage,
} from "./jobStates";

const RUNNING_STATES = JOB_STATES.filter((state) => kindOf(state) === "running");

/**
 * Jobs and the moves between their states (platform spec B9). Every move
 * goes through `moveJob`, which refuses one outside the table and records
 * each change with its time; the runner, intake and the owner's actions
 * all use it.
 */

export interface Job {
  id: string;
  state: JobState;
  pendingStage: StageName | null;
  stateChangedAt: Date;
  failedStage: StageName | null;
  failure: string | null;
  retryRound: number;
  receivedAt: Date;
  clientElapsedMs: number;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
}

// A job left uploading this long after it began to upload has failed (intake spec).
export const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

type JobRow = {
  id: string;
  state: JobState;
  pending_stage: StageName | null;
  state_changed_at: Date;
  failed_stage: StageName | null;
  failure: string | null;
  retry_round: number;
  received_at: Date;
  client_elapsed_ms: number;
  lease_id: string | null;
  lease_expires_at: Date | null;
};

const COLUMNS = `id, state, pending_stage, state_changed_at, failed_stage, failure, retry_round,
  received_at, client_elapsed_ms, lease_id, lease_expires_at`;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    state: row.state,
    pendingStage: row.pending_stage,
    stateChangedAt: row.state_changed_at,
    failedStage: row.failed_stage,
    failure: row.failure,
    retryRound: row.retry_round,
    receivedAt: row.received_at,
    clientElapsedMs: row.client_elapsed_ms,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
  };
}

// The most the column holds: about 24 days, far beyond any phone's wait.
const MAX_CLIENT_ELAPSED_MS = 2 ** 31 - 1;

/**
 * A new job, in the state intake starts it in: `uploading`, or `manual_run`
 * for the manual arm (ledger spec). `receivedAt` is the server's time of the
 * request; the job starts `clientElapsedMs` before it, rounded to whole
 * milliseconds since phones measure it with a fractional timer.
 */
export async function createJob(
  db: Db,
  job: { state: "uploading" | "manual_run"; receivedAt: Date; clientElapsedMs: number },
): Promise<string> {
  const clientElapsedMs = Math.round(job.clientElapsedMs);
  if (!(clientElapsedMs >= 0 && clientElapsedMs <= MAX_CLIENT_ELAPSED_MS)) {
    throw new RangeError(
      `clientElapsedMs must be a duration in milliseconds, not ${job.clientElapsedMs}`,
    );
  }
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into {{schema}}.jobs (state, state_changed_at, received_at, client_elapsed_ms)
       values ($1, $2, $2, $3)
       returning id`,
      [job.state, job.receivedAt, clientElapsedMs],
    );
    const id = rows[0]!.id;
    await tx.query(
      `insert into {{schema}}.job_state_changes (job_id, from_state, to_state, at)
       values ($1, null, $2, $3)`,
      [id, job.state, job.receivedAt],
    );
    return id;
  });
}

export async function loadJob(db: Db, id: string): Promise<Job | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<JobRow>(`select ${COLUMNS} from {{schema}}.jobs where id = $1`, [
    id,
  ]);
  return rows[0] ? toJob(rows[0]) : null;
}

export interface Move {
  from: JobState;
  to: JobState;
  pending: StageName | null;
  at: Date;
  /** Required to enter `failed`: the stage that failed and the reason the page shows. */
  failure?: { stage: StageName; reason: string };
  /** Retry starts a new round of attempts. */
  newRound?: boolean;
  /**
   * The lease of the invocation moving a running job. Only the runner moves
   * a running job, and only while its lease is live at `at`; one it lost,
   * or one that expired, moves nothing.
   */
  leaseId?: string;
  /**
   * For a running job, the stage the runner read as pending: some moves of
   * the table hold only after one stage, and a job whose pending stage
   * changed since the read moves nothing.
   */
  fromPending?: StageName | null;
  /** When the job last changed state as the caller read it; a job changed since moves nothing. */
  ifChangedAt?: Date;
}

/**
 * Moves the job when it is still in `move.from` (and as the conditions in
 * `move` say), recording the change; one conditional update, so it never
 * acts on a stale read. Returns false when the job was not as expected,
 * because another request moved it first. A failed job resumes only at
 * the stage it failed at, and keeps the failure's stage and reason when
 * Skip closes it. A job that leaves the running states leaves its lease
 * too, so a job the runner parked is free to claim at once, though the
 * invocation dies before it releases the lease. A move outside the table,
 * or a running job moved without
 * a lease or without naming the stage it leaves, is a bug in the caller, so
 * it throws. Times are compared to the millisecond, as JavaScript reads
 * them; Postgres keeps microseconds.
 */
export async function moveJob(db: Db, id: string, move: Move): Promise<boolean> {
  const running = kindOf(move.from) === "running";
  if (running && move.leaseId === undefined) {
    throw new Error("Refused job move: a running job moves only under the runner's lease");
  }
  if (running && move.fromPending === undefined) {
    throw new Error("Refused job move: the runner names the stage a running job leaves");
  }
  const check = checkMove(move.from, move.to, move.pending, move.fromPending ?? null);
  if (!check.ok) throw new Error(`Refused job move: ${check.reason}`);
  if ((move.to === "failed") !== (move.failure !== undefined)) {
    throw new Error("Refused job move: a failure goes with the move to failed, and only there");
  }
  return db.tx(async (tx) => {
    const moved = await claimOne(
      tx,
      `update {{schema}}.jobs
          set state = $3, pending_stage = $4, state_changed_at = $5,
              failed_stage = case $3 when 'failed' then $6 when 'closed' then failed_stage end,
              failure = case $3 when 'failed' then $7 when 'closed' then failure end,
              retry_round = retry_round + $8,
              lease_id = case when $3 = any($13::text[]) then lease_id end,
              lease_expires_at = case when $3 = any($13::text[]) then lease_expires_at end
        where id = $1 and state = $2
          and ($9::uuid is null or (lease_id = $9 and lease_expires_at > $5))
          and ($2 <> 'failed' or $3 = 'closed' or pending_stage = $4)
          and ($10::timestamptz is null or date_trunc('milliseconds', state_changed_at) = $10)
          and (not $11::boolean or pending_stage is not distinct from $12::text)
        returning id`,
      [
        id,
        move.from,
        move.to,
        move.pending,
        move.at,
        move.failure?.stage ?? null,
        move.failure?.reason ?? null,
        move.newRound ? 1 : 0,
        move.leaseId ?? null,
        move.ifChangedAt ?? null,
        move.fromPending !== undefined,
        move.fromPending ?? null,
        RUNNING_STATES,
      ],
    );
    if (!moved) return false;
    await tx.query(
      `insert into {{schema}}.job_state_changes (job_id, from_state, to_state, at)
       values ($1, $2, $3, $4)`,
      [id, move.from, move.to, move.at],
    );
    return true;
  });
}

type Outcome<R extends string> = { ok: true } | { ok: false; reason: R };

/** Retry: the failed stage runs again in its running state, its attempts counted afresh. */
export async function retryJob(
  deps: { db: Db; clock: Clock },
  id: string,
): Promise<Outcome<"not-found" | "not-failed">> {
  const job = await loadJob(deps.db, id);
  if (!job) return { ok: false, reason: "not-found" };
  const resumes = job.pendingStage === null ? null : stateOfStage(job.pendingStage);
  if (job.state !== "failed" || resumes === null) return { ok: false, reason: "not-failed" };
  const moved = await moveJob(deps.db, id, {
    from: "failed",
    to: resumes,
    pending: job.pendingStage,
    at: deps.clock.now(),
    newRound: true,
    ifChangedAt: job.stateChangedAt,
  });
  return moved ? { ok: true } : { ok: false, reason: "not-failed" };
}

// A role pick's Skip may return to kit_ready instead, which extraction decides.
const SKIPPABLE: ReadonlySet<JobState> = new Set([
  "failed",
  "upload_failed",
  "stopped",
  "needs_eligibility_decision",
  "needs_kit_type",
]);

/**
 * Skip closes a job that failed, whose upload failed, that extraction
 * stopped, or that waits on an eligibility or kit-type decision.
 */
export async function skipJob(
  deps: { db: Db; clock: Clock },
  id: string,
): Promise<Outcome<"not-found" | "not-skippable">> {
  const job = await loadJob(deps.db, id);
  if (!job) return { ok: false, reason: "not-found" };
  if (!SKIPPABLE.has(job.state)) return { ok: false, reason: "not-skippable" };
  const moved = await moveJob(deps.db, id, {
    from: job.state,
    to: "closed",
    pending: null,
    at: deps.clock.now(),
    ifChangedAt: job.stateChangedAt,
  });
  return moved ? { ok: true } : { ok: false, reason: "not-skippable" };
}

/**
 * Timeouts, applied whenever status is read and by the daily backstop: a
 * job still uploading 15 minutes after it began to upload (at creation, or
 * at Upload again) moves to `upload_failed`, as of that deadline rather
 * than of the read, so a late read adds nothing to the job's times. A job
 * that changed since the read, as by an upload begun again, is left alone.
 * Returns how many jobs it moved.
 */
export async function expireUploads(db: Db, now: Date, jobId?: string): Promise<number> {
  const { rows } = await db.query<{ id: string; state_changed_at: Date }>(
    `select id, state_changed_at from {{schema}}.jobs
      where state = 'uploading' and state_changed_at <= $1 and ($2::uuid is null or id = $2)`,
    [new Date(now.getTime() - UPLOAD_TIMEOUT_MS), jobId ?? null],
  );
  let moved = 0;
  for (const row of rows) {
    const at = new Date(row.state_changed_at.getTime() + UPLOAD_TIMEOUT_MS);
    const done = await moveJob(db, row.id, {
      from: "uploading",
      to: "upload_failed",
      pending: null,
      at,
      ifChangedAt: row.state_changed_at,
    });
    if (done) moved += 1;
  }
  return moved;
}

/** The job as a status read sees it: its timeouts applied first. */
export async function jobStatus(deps: { db: Db; clock: Clock }, id: string): Promise<Job | null> {
  if (!isUuid(id)) return null;
  await expireUploads(deps.db, deps.clock.now(), id);
  return loadJob(deps.db, id);
}
