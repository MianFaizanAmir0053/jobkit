import { join } from "node:path";

import { createPgliteDb, type PgliteDb } from "@/adapters/pglite";

import { applyMigrations, bootstrapForTests, loadMigrations } from "./migrate";

/** An in-memory database with every migration applied, for integration tests. */
export async function createTestDb(): Promise<PgliteDb> {
  const db = await createPgliteDb({ schema: "jobkit" });
  await bootstrapForTests(db);
  await applyMigrations(db, loadMigrations(join(process.cwd(), "db", "migrations")));
  return db;
}

/**
 * Closed jobs with the given IDs, for tests of rows that must belong to a
 * job (applications, model calls) but do not care about the job itself.
 */
export async function insertTestJobs(db: PgliteDb, ids: readonly string[]): Promise<void> {
  await db.query(
    `insert into {{schema}}.jobs (id, state, state_changed_at, received_at)
     select id, 'closed', now(), now() from unnest($1::uuid[]) as id
     on conflict (id) do nothing`,
    [ids],
  );
}
