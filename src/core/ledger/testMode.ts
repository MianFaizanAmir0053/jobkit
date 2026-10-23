import type { Clock, Db } from "@/core/ports";

/**
 * Test mode (ledger spec, "Test jobs"; the owner's choice, 2026-10-22):
 * for an hour from the owner's tap, every job created, from New job or from
 * a share, is a test job, which draws no arm, never starts real use, and
 * enters no figure on the Stats page. It ends by itself when the hour is
 * up, or when the owner ends it, so a test session left on cannot swallow
 * the real jobs after it.
 */

export const TEST_MODE_MS = 60 * 60 * 1000;

type Deps = { db: Db; clock: Clock };

/** When test mode ends, while it is on; null while it is off. */
export async function testModeUntil(deps: Deps): Promise<Date | null> {
  const { rows } = await deps.db.query<{ until: Date | null }>(
    "select test_until as until from {{schema}}.measurement where id = 1",
  );
  const until = rows[0]?.until ?? null;
  return until !== null && until.getTime() > deps.clock.now().getTime() ? until : null;
}

/** Turns test mode on for an hour from now, or off; gives when it ends, or null once off. */
export async function setTestMode(deps: Deps, on: boolean): Promise<Date | null> {
  const until = on ? new Date(deps.clock.now().getTime() + TEST_MODE_MS) : null;
  await deps.db.query(
    `insert into {{schema}}.measurement (id, test_until) values (1, $1)
     on conflict (id) do update set test_until = excluded.test_until`,
    [until],
  );
  return until;
}
