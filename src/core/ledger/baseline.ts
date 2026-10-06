import { claimOne } from "@/core/platform/claim";
import type { Clock, Db } from "@/core/ports";

import { median, percentile } from "./stats";

/**
 * The Baseline page (ledger spec, "The timing comparison"): before real use,
 * the owner times applications done the old way. Start when the post is in
 * hand, Stop when it is sent, then say the route, company and role. These
 * runs are reported on their own and never enter the comparison's ratio.
 */
export type BaselineRoute = "email" | "form" | "message";
export const BASELINE_ROUTES: readonly BaselineRoute[] = ["email", "form", "message"];

const MAX_TEXT = 200;

export interface BaselineRun {
  id: string;
  startedAt: Date;
  stoppedAt: Date | null;
  route: BaselineRoute | null;
  company: string | null;
  role: string | null;
  durationMs: number | null;
}

export interface TimingSummary {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface BaselineSummary extends TimingSummary {
  running: BaselineRun | null;
  runningForMs: number | null;
  byRoute: Record<BaselineRoute, TimingSummary>;
  recent: BaselineRun[];
}

type Deps = { db: Db; clock: Clock };

type Row = {
  id: string;
  started_at: Date;
  stopped_at: Date | null;
  route: BaselineRoute | null;
  company: string | null;
  role: string | null;
};

const COLUMNS = "id, started_at, stopped_at, route, company, role";

function toRun(row: Row): BaselineRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    route: row.route,
    company: row.company,
    role: row.role,
    durationMs: row.stopped_at ? row.stopped_at.getTime() - row.started_at.getTime() : null,
  };
}

export async function startBaselineRun(
  deps: Deps,
): Promise<{ ok: true; run: BaselineRun } | { ok: false; reason: "already-running" }> {
  // The unique index on running runs turns a second Start into a no-op.
  const { rows } = await deps.db.query<Row>(
    `insert into {{schema}}.baseline_runs (started_at) values ($1)
     on conflict do nothing returning ${COLUMNS}`,
    [deps.clock.now()],
  );
  return rows[0] ? { ok: true, run: toRun(rows[0]) } : { ok: false, reason: "already-running" };
}

export async function stopBaselineRun(
  deps: Deps,
  input: { route: BaselineRoute; company: string; role: string },
): Promise<{ ok: true; run: BaselineRun } | { ok: false; reason: "invalid" | "not-running" }> {
  const company = input.company.trim();
  const role = input.role.trim();
  const valid = (text: string) => text.length > 0 && text.length <= MAX_TEXT;
  if (!BASELINE_ROUTES.includes(input.route) || !valid(company) || !valid(role)) {
    return { ok: false, reason: "invalid" };
  }
  const row = await claimOne<Row>(
    deps.db,
    `update {{schema}}.baseline_runs
        set stopped_at = $1, route = $2, company = $3, role = $4
      where stopped_at is null
      returning ${COLUMNS}`,
    [deps.clock.now(), input.route, company, role],
  );
  return row ? { ok: true, run: toRun(row) } : { ok: false, reason: "not-running" };
}

/** Throws away a stopwatch started by mistake. */
export async function discardBaselineRun(deps: Deps): Promise<boolean> {
  const { rowCount } = await deps.db.query(
    "delete from {{schema}}.baseline_runs where stopped_at is null",
  );
  return rowCount > 0;
}

export async function baselineSummary(deps: Deps): Promise<BaselineSummary> {
  const { rows } = await deps.db.query<Row>(
    `select ${COLUMNS} from {{schema}}.baseline_runs order by started_at desc`,
  );
  const runs = rows.map(toRun);
  const running = runs.find((run) => run.stoppedAt === null) ?? null;
  const stopped = runs.filter((run) => run.stoppedAt !== null);
  const byRoute = Object.fromEntries(
    BASELINE_ROUTES.map((route) => [route, summarise(stopped.filter((r) => r.route === route))]),
  ) as Record<BaselineRoute, TimingSummary>;
  return {
    ...summarise(stopped),
    running,
    runningForMs: running ? deps.clock.now().getTime() - running.startedAt.getTime() : null,
    byRoute,
    recent: stopped.slice(0, 10),
  };
}

function summarise(runs: readonly BaselineRun[]): TimingSummary {
  const durations = runs.map((run) => run.durationMs!);
  const round = (value: number | null) => (value === null ? null : Math.round(value));
  return {
    count: durations.length,
    medianMs: round(median(durations)),
    p90Ms: round(percentile(durations, 90)),
  };
}
