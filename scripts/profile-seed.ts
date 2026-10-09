/**
 *   npm run profile:seed                                   private/profile.yaml, the local database
 *   npm run profile:seed -- --prod                         private/profile.yaml, production
 *   npm run profile:seed -- evals/synthetic/profile.sample.yaml   the public sample, locally
 *
 * Checks the profile file, its CV and its style examples (profile spec,
 * "Seeding"), and reports every problem with its line. A good file becomes
 * the active version; one already seeded is made active again, which is how
 * the owner rolls back.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { systemClock } from "@/adapters/clock";
import { createLocalStorage } from "@/adapters/localStorage";
import { createPgDb } from "@/adapters/pg";
import { createPgliteDb } from "@/adapters/pglite";
import { createSupabaseStorage } from "@/adapters/supabaseStorage";
import { seedProfile } from "@/core/profile/seed";
import type { Db, Storage } from "@/core/ports";
import { BUCKET, SCHEMA } from "@/server/container";
import { applyMigrations, bootstrapForTests, loadMigrations } from "@/server/db/migrate";
import { loadProfileFile } from "@/server/profileFile";

import {
  askOnTerminal,
  confirmProduction,
  loadOpsEnv,
  parseTarget,
  projectRefFromSupabaseUrl,
  requireValues,
} from "./ops";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = resolve(
    args.find((arg) => !arg.startsWith("--")) ?? join("private", "profile.yaml"),
  );
  const target = parseTarget(args.filter((arg) => arg.startsWith("--")));
  if (!existsSync(file))
    throw new Error(`${file} does not exist: see the profile spec, "Drafting the first version"`);

  const checked = loadProfileFile(file);
  if (!checked.ok) {
    for (const { line, message } of checked.problems)
      console.error(`line ${line ?? "?"}: ${message}`);
    throw new Error(`${checked.problems.length} problem(s), so nothing was seeded.`);
  }

  const { db, storage, where } = target === "local" ? await local() : await production();
  try {
    const { status, versionId } = await seedProfile({ db, storage, clock: systemClock }, checked);
    const said = {
      created: "Seeded a new profile version",
      reactivated: "Made an earlier profile version active again",
      unchanged: "Nothing changed; the active profile version is",
    }[status];
    console.log(`${said} ${versionId} in ${where} (hash ${checked.hash.slice(0, 12)}).`);
  } finally {
    await db.close();
  }
}

async function local(): Promise<{
  db: Db & { close(): Promise<void> };
  storage: Storage;
  where: string;
}> {
  const data = join(process.cwd(), ".data");
  const db = await createPgliteDb({ schema: SCHEMA, dataDir: join(data, "pglite") });
  await bootstrapForTests(db);
  await applyMigrations(db, loadMigrations(join(process.cwd(), "db", "migrations")));
  const storage = createLocalStorage({
    root: join(data, "storage"),
    origin: "http://localhost:3000",
  });
  return { db, storage, where: "the local database" };
}

async function production(): Promise<{
  db: Db & { close(): Promise<void> };
  storage: Storage;
  where: string;
}> {
  const env = loadOpsEnv();
  requireValues(env, ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  const ref = projectRefFromSupabaseUrl(env.SUPABASE_URL!);
  await confirmProduction(ref, askOnTerminal);
  const db = createPgDb({ connectionString: env.DATABASE_URL!, schema: SCHEMA, max: 1 });
  const storage = createSupabaseStorage({
    url: env.SUPABASE_URL!,
    secretKey: env.SUPABASE_SECRET_KEY!,
    bucket: BUCKET,
  });
  return { db, storage, where: `production (${ref})` };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
