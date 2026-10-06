import type { Clock, Db } from "@/core/ports";

import { expirePendingPairings } from "./pairing";

/**
 * The scheduled jobs (platform spec B6). Supabase's free tier pauses a
 * project after a week without activity, so a GitHub schedule calls the
 * keep-alive every 8 hours and Vercel's cron calls the daily job once a day.
 * Vercel may skip a run or deliver it twice, so both are idempotent.
 */
type Deps = { db: Db; clock: Clock };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Three small queries and the heartbeat: all the keep-alive secret can do. */
export async function keepAlive(deps: Deps): Promise<void> {
  await deps.db.query("select 1");
  await deps.db.query("select count(*) from {{schema}}.heartbeat");
  await deps.db.query("select max(version) from {{schema}}.schema_migrations");
  await deps.db.query("update {{schema}}.heartbeat set touched_at = $1 where id = 1", [
    deps.clock.now(),
  ]);
}

export interface DailyResult {
  expiredPairings: number;
  endedSessions: number;
  oldPairingTokens: number;
}

/**
 * The heartbeat, the backstop for timeouts that status reads normally apply
 * (B9), and housekeeping: rows of ended sessions and pairing tokens a day
 * past their expiry are dead weight. Intake's and the ledger's retention
 * purges join this job when those modules arrive.
 */
export async function dailyMaintenance(deps: Deps): Promise<DailyResult> {
  await keepAlive(deps);
  const now = deps.clock.now();
  const expiredPairings = await expirePendingPairings(deps.db, now);
  const ended = await deps.db.query("delete from {{schema}}.sessions where expires_at <= $1", [
    now,
  ]);
  const tokens = await deps.db.query(
    "delete from {{schema}}.pairing_tokens where expires_at <= $1",
    [new Date(now.getTime() - DAY_MS)],
  );
  return {
    expiredPairings,
    endedSessions: ended.rowCount,
    oldPairingTokens: tokens.rowCount,
  };
}
