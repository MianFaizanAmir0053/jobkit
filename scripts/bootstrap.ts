/**
 *   npm run db:bootstrap            creates the schema in the local PGlite database
 *   npm run db:bootstrap -- --prod  production, once: the jobkit_app role, its schema
 *                                   and the private storage bucket (platform spec B1)
 */
import { join } from "node:path";

import { createPgDb } from "@/adapters/pg";
import { createSupabaseStorage } from "@/adapters/supabaseStorage";
import { openLocalDb } from "@/server/db/localDb";
import { bootstrapForTests } from "@/server/db/migrate";
import { BUCKET, SCHEMA } from "@/server/container";

import {
  askOnTerminal,
  confirmProduction,
  loadOpsEnv,
  parseTarget,
  projectRefFromSupabaseUrl,
  requireValues,
  schemaStatements,
} from "./ops";

const ROLE = "jobkit_app";

async function main(): Promise<void> {
  if (parseTarget(process.argv.slice(2)) === "local") {
    const db = await openLocalDb(join(process.cwd(), ".data"), {
      schema: SCHEMA,
      holder: "npm run db:bootstrap",
    });
    await bootstrapForTests(db);
    await db.close();
    console.log("Local schema ready.");
    return;
  }

  const env = loadOpsEnv();
  requireValues(env, [
    "DATABASE_BOOTSTRAP_URL",
    "JOBKIT_APP_DB_PASSWORD",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
  ]);
  await confirmProduction(projectRefFromSupabaseUrl(env.SUPABASE_URL!), askOnTerminal);

  const db = createPgDb({ connectionString: env.DATABASE_BOOTSTRAP_URL!, schema: SCHEMA, max: 1 });
  try {
    // DDL cannot take parameters, so Postgres itself escapes the password with format(%L).
    const exists = await db.query("select 1 from pg_roles where rolname = $1", [ROLE]);
    const verb = exists.rowCount > 0 ? "alter" : "create";
    const statement = await db.query<{ sql: string }>(
      `select format('${verb} role %I with login password %L', $1::text, $2::text) as sql`,
      [ROLE, env.JOBKIT_APP_DB_PASSWORD],
    );
    await db.exec(statement.rows[0]!.sql);
    for (const sql of schemaStatements({ schema: SCHEMA, role: ROLE })) await db.exec(sql);
  } finally {
    await db.close();
  }

  await createSupabaseStorage({
    url: env.SUPABASE_URL!,
    secretKey: env.SUPABASE_SECRET_KEY!,
    bucket: BUCKET,
  }).ensureBucket();
  console.log(`Role ${ROLE}, schema ${SCHEMA} and bucket ${BUCKET} are ready.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
