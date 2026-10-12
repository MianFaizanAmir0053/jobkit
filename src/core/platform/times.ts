import type { Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { type JobState, kindOf } from "./jobStates";

/**
 * A job's times (platform spec B9), from its state changes, stage runs and
 * lease history.
 *
 * - Machine time runs from the job's start (intake's clock) to its first
 *   `kit_ready`. Upload, cold starts and normal poll delays count; time in a
 *   `waiting` or `owner` state does not. Where the job could run but no
 *   page polled to claim it (a locked phone, a closed app), a gap's first 10
 *   seconds count as a poll's normal delay, and the rest is reported as
 *   paused time instead (the owner's choices, 2026-10-11 and 2026-10-12: the
 *   page polls every 5 seconds after a minute, and a poll's network time and
 *   any cold start come on top, which the spec counts).
 * - Processing time is the union of the stage runs up to that `kit_ready`,
 *   so the drafting group's concurrent stages count once.
 */

export interface TimesInput {
  /** The job's start: its server receipt less the time the phone held it. */
  start: Date;
  /** Every state change in order, the first being the state the job was created in. */
  changes: readonly { to: JobState; at: Date }[];
  /** Each claim of the lease, until its release or, for a killed invocation, its expiry. */
  leases: readonly { claimedAt: Date; endsAt: Date }[];
  runs: readonly { startedAt: Date; endedAt: Date | null }[];
}

export interface JobTimes {
  machineMs: number;
  pausedMs: number;
  processingMs: number;
}

// The longest wait a polling page and its request explain; an unclaimed gap's remainder is paused.
const POLL_DELAY_MS = 10_000;

type Span = [number, number];

export function jobTimes(input: TimesInput): JobTimes | null {
  const end = input.changes.find((change) => change.to === "kit_ready")?.at.getTime();
  const first = input.changes[0];
  if (end === undefined || first === undefined) return null;

  const counted: Span[] = [[input.start.getTime(), first.at.getTime()]];
  const running: Span[] = [];
  // Spans after the first kit_ready come out empty, and union() drops them.
  input.changes.forEach((change, i) => {
    const from = change.at.getTime();
    const to = Math.min(input.changes[i + 1]?.at.getTime() ?? end, end);
    const kind = kindOf(change.to);
    if (kind === "running") running.push([from, to]);
    else if (kind === "client") counted.push([from, to]);
  });

  const claimed = union(
    input.leases.map((lease) => [lease.claimedAt.getTime(), lease.endsAt.getTime()]),
  );
  let pausedMs = 0;
  for (const span of union(running)) {
    for (const gap of without(span, claimed)) {
      const polled: Span = [gap[0], Math.min(gap[1], gap[0] + POLL_DELAY_MS)];
      counted.push(polled);
      pausedMs += length(gap) - length(polled);
    }
    counted.push(...within(span, claimed));
  }

  const runs = input.runs
    .filter((run) => run.endedAt !== null)
    .map((run): Span => [run.startedAt.getTime(), Math.min(run.endedAt!.getTime(), end)]);
  return {
    machineMs: total(union(counted)),
    pausedMs,
    processingMs: total(union(runs)),
  };
}

/** The job's times as its rows record them, or null before its first `kit_ready`. */
export async function loadJobTimes(db: Db, jobId: string): Promise<JobTimes | null> {
  if (!isUuid(jobId)) return null;
  const job = await db.query<{ received_at: Date; client_elapsed_ms: number }>(
    "select received_at, client_elapsed_ms from {{schema}}.jobs where id = $1",
    [jobId],
  );
  const row = job.rows[0];
  if (!row) return null;
  const changes = await db.query<{ to_state: JobState; at: Date }>(
    "select to_state, at from {{schema}}.job_state_changes where job_id = $1 order by id",
    [jobId],
  );
  const leases = await db.query<{ claimed_at: Date; ends_at: Date }>(
    `select claimed_at, coalesce(released_at, expires_at) as ends_at
       from {{schema}}.job_leases where job_id = $1`,
    [jobId],
  );
  const runs = await db.query<{ started_at: Date; ended_at: Date | null }>(
    "select started_at, ended_at from {{schema}}.job_stage_runs where job_id = $1",
    [jobId],
  );
  return jobTimes({
    start: new Date(row.received_at.getTime() - row.client_elapsed_ms),
    changes: changes.rows.map((change) => ({ to: change.to_state, at: change.at })),
    leases: leases.rows.map((lease) => ({ claimedAt: lease.claimed_at, endsAt: lease.ends_at })),
    runs: runs.rows.map((run) => ({ startedAt: run.started_at, endedAt: run.ended_at })),
  });
}

function length([from, to]: Span): number {
  return Math.max(0, to - from);
}

function total(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + length(span), 0);
}

/** The spans merged where they overlap or touch, in order; empty spans dropped. */
function union(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((span) => length(span) > 0).sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** The parts of a span that merged spans cover. */
function within(span: Span, covers: readonly Span[]): Span[] {
  return covers
    .map(([from, to]): Span => [Math.max(from, span[0]), Math.min(to, span[1])])
    .filter((part) => length(part) > 0);
}

/** The parts of a span that merged spans leave uncovered. */
function without(span: Span, covers: readonly Span[]): Span[] {
  const gaps: Span[] = [];
  let cursor = span[0];
  for (const [from, to] of covers) {
    if (to <= cursor || from >= span[1]) continue;
    if (from > cursor) gaps.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < span[1]) gaps.push([cursor, span[1]]);
  return gaps;
}
