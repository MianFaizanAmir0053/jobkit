/**
 * The composition root (platform spec A3): wires adapters to ports from the
 * environment. Production uses Supabase through `pg` and Supabase Storage;
 * development keeps a PGlite database and files under `.data/`; tests use
 * an in-memory database and a temporary folder.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemClock } from "@/adapters/clock";
import { createDns, offlineDns } from "@/adapters/dns";
import { createLocalStorage } from "@/adapters/localStorage";
import { createPgDb } from "@/adapters/pg";
import { createPgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { createSupabaseStorage } from "@/adapters/supabaseStorage";
import type { Clock, Db, Dns, Llm, Random, Storage } from "@/core/ports";
import { openLocalDb } from "@/server/db/localDb";
import { applyMigrations, bootstrapForTests, loadMigrations } from "@/server/db/migrate";
import { onVercelDeployment } from "@/server/deployEnv";
import { assertLocalOnly, isLocalRun } from "@/server/localOnly";
import { modelsFor } from "@/server/models";

export const SCHEMA = "jobkit";
export const BUCKET = "jobkit-private";

export interface Container {
  kind: "production" | "development" | "test";
  db: Db;
  storage: Storage;
  clock: Clock;
  random: Random;
  /** Real lookups, except on the test server, where every domain takes mail. */
  dns: Dns;
  /** The model behind a model ID; throws when this environment has no key for it. */
  llmFor(model: string): Llm;
  close(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

const SYSTEM = { clock: systemClock, random: cryptoRandom };

function required(env: Env, names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables for production: ${missing.join(", ")}`);
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!]));
}

export async function createContainer(
  env: Env,
  opts: { dataDir?: string; migrationsDir?: string } = {},
): Promise<Container> {
  // Vercel holds only production, so a wrong JOBKIT_ENV there must stop the
  // app rather than give it an in-memory database and the test routes.
  if (onVercelDeployment(env) && env.JOBKIT_ENV !== "production") {
    throw new Error(
      `This is a Vercel ${env.VERCEL_ENV} deployment, so JOBKIT_ENV must be production, not ${JSON.stringify(env.JOBKIT_ENV)}`,
    );
  }
  // Checked on every build as well as at server start: the dev server
  // reloads edited .env files, and a container that failed to start is built
  // again from them (B8). One already built keeps the keys it read then.
  if (isLocalRun(env)) assertLocalOnly(env, "A local run");
  switch (env.JOBKIT_ENV) {
    case "production": {
      // The model keys are not required here: a missing one fails only the
      // stages that need it, while sign-in, pairing and the keep-alive go on.
      const v = required(env, ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
      const db = createPgDb({ connectionString: v.DATABASE_URL!, schema: SCHEMA });
      const storage = createSupabaseStorage({
        url: v.SUPABASE_URL!,
        secretKey: v.SUPABASE_SECRET_KEY!,
        bucket: BUCKET,
      });
      const llmFor = modelsFor("production", env);
      const dns = createDns();
      return { kind: "production", db, storage, ...SYSTEM, dns, llmFor, close: () => db.close() };
    }
    case "development":
    case "test": {
      const dataDir =
        env.JOBKIT_ENV === "development"
          ? (opts.dataDir ?? join(process.cwd(), ".data"))
          : (opts.dataDir ?? mkdtempSync(join(tmpdir(), "jobkit-test-")));
      // The development database is kept under a lock that the scripts' local mode respects.
      const db =
        env.JOBKIT_ENV === "development"
          ? await openLocalDb(dataDir, { schema: SCHEMA, holder: "the dev server" })
          : await createPgliteDb({ schema: SCHEMA });
      // A start that fails lets go of the database, so the next try can open it.
      try {
        await bootstrapForTests(db);
        const migrations = opts.migrationsDir ?? join(process.cwd(), "db", "migrations");
        await applyMigrations(db, loadMigrations(migrations));
        const storage = createLocalStorage({
          root: join(dataDir, "storage"),
          origin: env.APP_ORIGIN ?? "http://localhost:3000",
        });
        const llmFor = modelsFor(env.JOBKIT_ENV, env);
        const dns = env.JOBKIT_ENV === "test" ? offlineDns() : createDns();
        return {
          kind: env.JOBKIT_ENV,
          db,
          storage,
          ...SYSTEM,
          dns,
          llmFor,
          close: () => db.close(),
        };
      } catch (error) {
        await db.close();
        throw error;
      }
    }
    default:
      throw new Error(
        `JOBKIT_ENV must be production, development or test, not ${JSON.stringify(env.JOBKIT_ENV)}`,
      );
  }
}

const processWide = globalThis as typeof globalThis & { jobkitContainer?: Promise<Container> };

/**
 * The process's one container, built from its environment on first use. It
 * lives on globalThis so the dev server's reloads reuse the PGlite database
 * instead of opening its folder twice. A failed start is forgotten, so the
 * next request tries again.
 */
export function getContainer(): Promise<Container> {
  if (!processWide.jobkitContainer) {
    const starting = createContainer(process.env);
    processWide.jobkitContainer = starting;
    starting.catch(() => {
      if (processWide.jobkitContainer === starting) processWide.jobkitContainer = undefined;
    });
  }
  return processWide.jobkitContainer;
}
