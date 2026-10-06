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
