import { STAGES, type StageName } from "@/core/platform/jobStates";
import { loadJobTimes } from "@/core/platform/times";
import type { Db } from "@/core/ports";

import { BASELINE_ROUTES, type BaselineRoute } from "./baseline";
import { type Interval, medianInterval, ratioInterval } from "./bootstrap";
import { realUseStart } from "./realUse";
import { median, percentile, wilsonInterval } from "./stats";
import { type TrustGate, trustGateState } from "./trustGate";

/**
 * The Stats page's figures (ledger spec, "Timing and stats"), for real jobs
 * only: machine and total time, pooled and per route; each stage's median
 * processing time; the route mix; the upload success rate; the factual-edit
 * rate with its Wilson interval, and the trust gate; and, during real use,
 * the comparison of the two arms' total times with bootstrap intervals,
 * shown per route from 5 runs in each arm and pooled from 10.
 */

export interface Spread {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface ArmComparison {
  tool: { count: number; medianMs: number | null; interval: Interval | null };
  manual: { count: number; medianMs: number | null; interval: Interval | null };
  /** The manual arm's median over the tool arm's: how many times slower the old way is. */
  ratio: number | null;
  ratioInterval: Interval | null;
  /** Whether both arms have the runs the comparison needs to be shown. */
  shown: boolean;
}

export interface StatsReport {
  realUseSince: Date | null;
  machine: { pooled: Spread; byRoute: Record<BaselineRoute, Spread> };
  total: { pooled: Spread; byRoute: Record<BaselineRoute, Spread> };
  stages: { stage: StageName; runs: number; medianMs: number | null }[];
  routeMix: Record<BaselineRoute, number>;
  uploads: { ok: number; failed: number; rate: number | null };
  factualEdits: { edits: number; outcomes: number; rate: number | null; interval: Interval | null };
  /** Sentences the separate check held that the owner checked and sent unchanged, over kits that went. */
  judgeFalsePositives: { sentences: number; kits: number };
  trustGate: TrustGate;
  comparison: { pooled: ArmComparison; byRoute: Record<BaselineRoute, ArmComparison> };
}

/** The comparison shows per route once each arm has this many runs there, and pooled from POOLED. */
export const COMPARISON_MIN = { route: 5, pooled: 10 } as const;

function spread(values: readonly number[]): Spread {
  return { count: values.length, medianMs: median(values), p90Ms: percentile(values, 90) };
}

function byRoute<T>(make: (route: BaselineRoute) => T): Record<BaselineRoute, T> {
  return Object.fromEntries(BASELINE_ROUTES.map((route) => [route, make(route)])) as Record<
    BaselineRoute,
    T
  >;
}

function compared(tool: readonly number[], manual: readonly number[], min: number): ArmComparison {
  const toolMedian = median(tool);
  const manualMedian = median(manual);
  return {
    tool: { count: tool.length, medianMs: toolMedian, interval: medianInterval(tool) },
    manual: { count: manual.length, medianMs: manualMedian, interval: medianInterval(manual) },
    ratio: toolMedian && manualMedian !== null ? manualMedian / toolMedian : null,
    ratioInterval: ratioInterval(manual, tool),
    shown: tool.length >= min && manual.length >= min,
  };
}

type Application = {
  job_id: string;
  route: BaselineRoute | null;
  arm: "tool" | "manual" | null;
  kit_ready_at: Date | null;
  went_at: Date | null;
  started_at: Date;
};

/** Whether `a` went before `b`, or, neither having gone, reached its kit first. */
function before(a: Application, b: Application): boolean {
  const went = (each: Application) => each.went_at?.getTime() ?? Infinity;
  if (went(a) !== went(b)) return went(a) < went(b);
  const ready = (each: Application) => each.kit_ready_at?.getTime() ?? Infinity;
  return ready(a) < ready(b);
}

export async function statsReport(db: Db): Promise<StatsReport> {
  const realUseSince = await realUseStart(db);
  const { rows: all } = await db.query<Application>(
    `select a.job_id, a.route, a.arm, a.kit_ready_at, coalesce(a.sent_at, a.submitted_at) as went_at,
            j.received_at - make_interval(secs => j.client_elapsed_ms / 1000.0) as started_at
       from {{schema}}.applications as a
       join {{schema}}.jobs as j on j.id = a.job_id
      where a.job_kind = 'real'`,
  );
  // The times count each job once, though more than one of its roles got an application: by
  // the first of them to go, else the first to reach its kit.
  const firsts = new Map<string, Application>();
  for (const each of all) {
    const kept = firsts.get(each.job_id);
    if (!kept || before(each, kept)) firsts.set(each.job_id, each);
  }
  const applications = [...firsts.values()];

  // Machine time: every real job that reached its kit through jobkit.
  const machine: { route: BaselineRoute | null; ms: number }[] = [];
  for (const application of applications) {
    if (application.arm === "manual" || application.kit_ready_at === null) continue;
    const times = await loadJobTimes(db, application.job_id);
    if (times) machine.push({ route: application.route, ms: times.machineMs });
  }
  // Total time: from the job's start until it went; the manual arm's runs are compared apart.
  const went = applications.filter((each) => each.went_at !== null);
  const totalOf = (each: Application) => each.went_at!.getTime() - each.started_at.getTime();
  const tool = went.filter((each) => each.arm !== "manual");
  const machineOf = (route?: BaselineRoute) =>
    machine.filter((each) => route === undefined || each.route === route).map((each) => each.ms);
  const totalFor = (route?: BaselineRoute) =>
    tool.filter((each) => route === undefined || each.route === route).map(totalOf);

  // The comparison counts only runs made during real use, in their arms.
  const armRuns = (arm: "tool" | "manual", route?: BaselineRoute) =>
    went
      .filter(
        (each) =>
          each.arm === arm &&
          realUseSince !== null &&
          each.started_at.getTime() >= realUseSince.getTime() &&
          (route === undefined || each.route === route),
      )
      .map(totalOf);

  const { rows: runs } = await db.query<{ stage: StageName; ms: number }>(
    `select run.stage, extract(epoch from (run.ended_at - run.started_at)) * 1000 as ms
       from {{schema}}.job_stage_runs as run
      where run.outcome = 'ok' and run.ended_at is not null
        and exists (select 1 from {{schema}}.applications as a
                     where a.job_id = run.job_id and a.job_kind = 'real')`,
  );
  const stages = STAGES.map((stage) => {
    const times = runs.filter((run) => run.stage === stage).map((run) => Number(run.ms));
    return { stage, runs: times.length, medianMs: median(times) };
  }).filter((each) => each.runs > 0);

  // An attempt still open whose job has left uploading failed (ledger spec, "Records").
  const { rows: attempts } = await db.query<{ ok: number; failed: number }>(
    `select count(*) filter (where attempt.outcome = 'ok')::int as ok,
            count(*) filter (where attempt.outcome = 'failed'
                               or (attempt.outcome is null and job.state <> 'uploading'))::int as failed
       from {{schema}}.upload_attempts as attempt
       join {{schema}}.jobs as job on job.id = attempt.job_id`,
  );
  const ok = attempts[0]?.ok ?? 0;
  const failed = attempts[0]?.failed ?? 0;

  const { rows: outcomes } = await db.query<{ factual_edit: boolean }>(
    `select outcome.factual_edit from {{schema}}.draft_outcomes as outcome
       join {{schema}}.applications as a on a.id = outcome.application_id
      where outcome.kind = 'email' and a.job_kind = 'real'
      order by outcome.recorded_at`,
  );
  const edits = outcomes.filter((each) => each.factual_edit).length;

  const { rows: positives } = await db.query<{ sentences: number; kits: number }>(
    `select coalesce(sum(jsonb_array_length(final_draft->'judgeFalsePositives')), 0)::int as sentences,
            count(*)::int as kits
       from {{schema}}.applications
      where job_kind = 'real' and jsonb_typeof(final_draft->'judgeFalsePositives') = 'array'`,
  );

  return {
    realUseSince,
    machine: { pooled: spread(machineOf()), byRoute: byRoute((route) => spread(machineOf(route))) },
    total: { pooled: spread(totalFor()), byRoute: byRoute((route) => spread(totalFor(route))) },
    stages,
    // The route mix counts every application, each a kit of its own.
    routeMix: byRoute((route) => all.filter((each) => each.route === route).length),
    uploads: { ok, failed, rate: ok + failed === 0 ? null : ok / (ok + failed) },
    factualEdits: {
      edits,
      outcomes: outcomes.length,
      rate: outcomes.length === 0 ? null : edits / outcomes.length,
      interval: wilsonInterval(edits, outcomes.length),
    },
    judgeFalsePositives: positives[0] ?? { sentences: 0, kits: 0 },
    trustGate: trustGateState(
      outcomes.map((each) => ({ kind: "email", skipped: false, factualEdit: each.factual_edit })),
    ),
    comparison: {
      pooled: compared(armRuns("tool"), armRuns("manual"), COMPARISON_MIN.pooled),
      byRoute: byRoute((route) =>
        compared(armRuns("tool", route), armRuns("manual", route), COMPARISON_MIN.route),
      ),
    },
  };
}
