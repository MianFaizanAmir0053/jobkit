import { roundUsd } from "@/core/platform/prices";
import type { Db } from "@/core/ports";

import { SPEND_LIMITS } from "./spend";
import { median } from "./stats";

/**
 * The Spend page's figures (ledger spec, "Spend cap"): month-to-date cost,
 * the median cost per job and the cost per stage, all over the current UTC
 * calendar month, as the cap counts. Provisional costs are upper bounds,
 * and a model missing from the price table was charged at the highest
 * rates (platform spec B4): the page says how much of the total is each.
 */

export interface SpendReport {
  monthToDateUsd: number;
  /** Of the total, the provisional upper bounds: attempts that ended without usage. */
  provisionalUsd: number;
  /** Calls to a model missing from the price table, charged at the highest rates. */
  unknownPriceCalls: number;
  jobs: number;
  medianPerJobUsd: number | null;
  byStage: { stage: string; calls: number; costUsd: number }[];
  limits: typeof SPEND_LIMITS;
}

export async function spendReport(db: Db, now: Date): Promise<SpendReport> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const { rows: totals } = await db.query<{
    total: number;
    provisional: number;
    unknown: number;
  }>(
    `select coalesce(sum(cost_usd), 0)::float8 as total,
            coalesce(sum(cost_usd) filter (where cost_provisional), 0)::float8 as provisional,
            count(*) filter (where not price_known)::int as unknown
       from {{schema}}.model_calls where started_at >= $1 and started_at < $2`,
    [from, to],
  );
  const { rows: jobs } = await db.query<{ cost: number }>(
    `select sum(cost_usd)::float8 as cost from {{schema}}.model_calls
      where started_at >= $1 and started_at < $2 and job_id is not null
      group by job_id`,
    [from, to],
  );
  const { rows: stages } = await db.query<{ stage: string; calls: number; cost: number }>(
    `select stage, count(*)::int as calls, sum(cost_usd)::float8 as cost
       from {{schema}}.model_calls where started_at >= $1 and started_at < $2
      group by stage order by sum(cost_usd) desc, stage`,
    [from, to],
  );
  const perJob = median(jobs.map((job) => job.cost));
  return {
    monthToDateUsd: roundUsd(totals[0]?.total ?? 0),
    provisionalUsd: roundUsd(totals[0]?.provisional ?? 0),
    unknownPriceCalls: totals[0]?.unknown ?? 0,
    jobs: jobs.length,
    medianPerJobUsd: perJob === null ? null : roundUsd(perJob),
    byStage: stages.map((each) => ({
      stage: each.stage,
      calls: each.calls,
      costUsd: roundUsd(each.cost),
    })),
    limits: SPEND_LIMITS,
  };
}
