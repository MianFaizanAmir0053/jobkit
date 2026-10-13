/**
 * Where an operations script works (platform spec B8): the local database
 * and files under `.data/` by default, or production with `--prod`, after
 * the owner types the project reference.
 */
import { join } from "node:path";

import { createLocalStorage } from "@/adapters/localStorage";
import { createPgDb } from "@/adapters/pg";
import { createSupabaseStorage } from "@/adapters/supabaseStorage";
import type { Db, Storage } from "@/core/ports";
import { BUCKET, SCHEMA } from "@/server/container";
import { openLocalDb } from "@/server/db/localDb";
import { applyMigrations, bootstrapForTests, loadMigrations } from "@/server/db/migrate";

import {
  askOnTerminal,
  confirmProduction,
  loadOpsEnv,
  productionRef,
  requireValues,
  type Target,
} from "./ops";

export interface OpenTarget {
  db: Db & { close(): Promise<void> };
  storage: Storage;
  /** Where the script works, in words: "the local database", "production (<ref>)". */
  where: string;
}

/**
 * Opens the target's database and storage. `doing` names the work for the
 * production prompt ("This will <doing> production"); `holder` names the
 * script in the local database's lock.
 */
export async function openTarget(
  target: Target,
  doing: string,
  holder: string,
): Promise<OpenTarget> {
  if (target === "local") {
    const data = join(process.cwd(), ".data");
    const db = await openLocalDb(data, { schema: SCHEMA, holder });
    await bootstrapForTests(db);
    await applyMigrations(db, loadMigrations(join(process.cwd(), "db", "migrations")));
    const storage = createLocalStorage({
      root: join(data, "storage"),
      origin: "http://localhost:3000",
    });
    return { db, storage, where: "the local database" };
  }
  const env = loadOpsEnv();
  requireValues(env, ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  const ref = productionRef(env);
  console.log(`This will ${doing} production (${ref}).`);
  await confirmProduction(ref, askOnTerminal);
  const db = createPgDb({ connectionString: env.DATABASE_URL!, schema: SCHEMA, max: 1 });
  const storage = createSupabaseStorage({
    url: env.SUPABASE_URL!,
    secretKey: env.SUPABASE_SECRET_KEY!,
    bucket: BUCKET,
  });
  return { db, storage, where: `production (${ref})` };
}
