/**
 *   npm run db:migrate            the local PGlite database under .data/
 *   npm run db:migrate -- --prod  production, after typing the project reference
 */
import { join } from "node:path";

import { createPgDb } from "@/adapters/pg";
import { createPgliteDb } from "@/adapters/pglite";
import { applyMigrations, bootstrapForTests, loadMigrations } from "@/server/db/migrate";
import { SCHEMA } from "@/server/container";

import {
  askOnTerminal,
  confirmProduction,
  loadOpsEnv,
  parseTarget,
  projectRefFromSupabaseUrl,
  requireValues,
} from "./ops";

async function main(): Promise<void> {
  const migrations = loadMigrations(join(process.cwd(), "db", "migrations"));
  if (parseTarget(process.argv.slice(2)) === "local") {
    const db = await createPgliteDb({
      schema: SCHEMA,
      dataDir: join(process.cwd(), ".data", "pglite"),
    });
    await bootstrapForTests(db);
    report(await applyMigrations(db, migrations));
    await db.close();
    return;
  }
  const env = loadOpsEnv();
  requireValues(env, ["DATABASE_URL", "SUPABASE_URL"]);
  await confirmProduction(projectRefFromSupabaseUrl(env.SUPABASE_URL!), askOnTerminal);
  const db = createPgDb({ connectionString: env.DATABASE_URL!, schema: SCHEMA, max: 1 });
  try {
    report(await applyMigrations(db, migrations));
  } finally {
    await db.close();
  }
}

function report(applied: string[]): void {
  console.log(applied.length === 0 ? "Nothing to apply." : `Applied: ${applied.join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
