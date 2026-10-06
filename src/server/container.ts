/**
 * The composition root (platform spec A3): wires adapters to ports from the
 * environment. Production uses Supabase through `pg` and Supabase Storage;
 * development keeps a PGlite database and files under `.data/`; tests use
 * an in-memory database and a temporary folder.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalStorage } from "@/adapters/localStorage";
import { createPgDb } from "@/adapters/pg";
import { createPgliteDb } from "@/adapters/pglite";
import { createSupabaseStorage } from "@/adapters/supabaseStorage";
import type { Db, Storage } from "@/core/ports";
import { applyMigrations, bootstrapForTests, loadMigrations } from "@/server/db/migrate";

export const SCHEMA = "jobkit";
export const BUCKET = "jobkit-private";

export interface Container {
  kind: "production" | "development" | "test";
  db: Db;
  storage: Storage;
  close(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables for production: ${missing.join(", ")}`);
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!]));
}

export async function createContainer(
  env: Env,
  opts: { dataDir?: string } = {},
): Promise<Container> {
  switch (env.JOBKIT_ENV) {
    case "production": {
      const v = required(env, ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
      const db = createPgDb({ connectionString: v.DATABASE_URL!, schema: SCHEMA });
      const storage = createSupabaseStorage({
        url: v.SUPABASE_URL!,
        secretKey: v.SUPABASE_SECRET_KEY!,
        bucket: BUCKET,
      });
      return { kind: "production", db, storage, close: () => db.close() };
    }
    case "development":
    case "test": {
      const dataDir =
        env.JOBKIT_ENV === "development"
          ? (opts.dataDir ?? join(process.cwd(), ".data"))
          : (opts.dataDir ?? mkdtempSync(join(tmpdir(), "jobkit-test-")));
      const db = await createPgliteDb({
        schema: SCHEMA,
        dataDir: env.JOBKIT_ENV === "development" ? join(dataDir, "pglite") : undefined,
      });
      await bootstrapForTests(db);
      await applyMigrations(db, loadMigrations(join(process.cwd(), "db", "migrations")));
      const storage = createLocalStorage({
        root: join(dataDir, "storage"),
        origin: env.APP_ORIGIN ?? "http://localhost:3000",
      });
      return { kind: env.JOBKIT_ENV, db, storage, close: () => db.close() };
    }
    default:
      throw new Error(
        `JOBKIT_ENV must be production, development or test, not ${JSON.stringify(env.JOBKIT_ENV)}`,
      );
  }
}
