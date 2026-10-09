import type { ModelCallGuard } from "@/core/platform/models";
import { roundUsd } from "@/core/platform/prices";
import type { Clock, Db } from "@/core/ports";

/**
 * The monthly spend cap (ledger spec, "Spend cap"; ADR 0001 entry 24 and
 * A9). Month-to-date cost is the sum of the app's model calls in the
 * current UTC calendar month, as Anthropic's workspace limit counts it.
 * Provisional upper bounds count, and a model missing from the price table
 * was logged at the highest rates, so the cap errs high.
 */
export const SPEND_LIMITS = {
  /** The banner shows from here. */
  warnUsd: 20,
  /** New jobs are refused from here. */
  newJobsUsd: 25,
  /** Every model call is refused from here; a job already running can finish below it. */
  callsUsd: 26,
} as const;

export interface SpendState {
  monthToDateUsd: number;
  warn: boolean;
  newJobsAllowed: boolean;
  callsAllowed: boolean;
}

type Deps = { db: Db; clock: Clock };

export async function monthToDateCost(db: Db, now: Date): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const { rows } = await db.query<{ total: number }>(
    `select coalesce(sum(cost_usd), 0)::float8 as total
       from {{schema}}.model_calls where started_at >= $1 and started_at < $2`,
    [monthStart, nextMonthStart],
  );
  return roundUsd(rows[0]!.total);
}

export async function spendState(deps: Deps): Promise<SpendState> {
  const monthToDateUsd = await monthToDateCost(deps.db, deps.clock.now());
  return {
    monthToDateUsd,
    warn: monthToDateUsd >= SPEND_LIMITS.warnUsd,
    newJobsAllowed: monthToDateUsd < SPEND_LIMITS.newJobsUsd,
    callsAllowed: monthToDateUsd < SPEND_LIMITS.callsUsd,
  };
}

/**
 * The guard the composition hands the model-call wrapper (platform spec B4).
 * It reads the month's total, and the wrapper then logs the attempt at its
 * provisional cost before calling the model, so an attempt in flight counts
 * against the next guard. Only attempts whose guards run at the same moment
 * can both pass, overshooting by at most their provisional costs; the
 * workspace's own $30 limit (runbook step 6) is the hard stop.
 */
export function spendGuard(deps: Deps): ModelCallGuard {
  return async () => {
    const { callsAllowed } = await spendState(deps);
    return callsAllowed
      ? { ok: true }
      : {
          ok: false,
          message: `This month's model spend has reached $${SPEND_LIMITS.callsUsd}, so no model runs until next month.`,
        };
  };
}
