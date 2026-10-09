/**
 *   npm run ledger:import private/earlier.csv                       the local PGlite database under .data/
 *   npm run ledger:import -- private/earlier.csv --prod             production, after typing the project reference
 *   npm run ledger:import -- private/earlier.csv --replace [--prod] replaces the whole stored list with the file
 *
 * Imports the applications made before jobkit (ledger spec, "Earlier
 * applications"). Every row is checked first; if any is bad, each is
 * reported by its line and nothing is imported. Importing a list twice adds
 * nothing, and a row whose company, role and date match is corrected in
 * place; --replace also drops rows the file no longer has.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock } from "@/adapters/clock";
import { createPgDb } from "@/adapters/pg";
import { importEarlier, parseEarlierCsv, replaceEarlier } from "@/core/ledger/earlier";
import type { Db } from "@/core/ports";
import { SCHEMA } from "@/server/container";
import { openLocalDb } from "@/server/db/localDb";
import { applyMigrations, bootstrapForTests, loadMigrations } from "@/server/db/migrate";

import {
  askOnTerminal,
  confirmProduction,
  loadOpsEnv,
  parseTarget,
  productionRef,
  refuseSwallowedFlags,
  requireValues,
} from "./ops";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  if (!path) {
    throw new Error(
      "Name the list: npm run ledger:import private/earlier.csv (add -- before it to use --prod)",
    );
  }
  refuseSwallowedFlags(["replace"]);
  const replace = args.includes("--replace");
  const target = parseTarget(args.filter((arg) => arg !== path && arg !== "--replace"));
  const { rows, errors } = parseEarlierCsv(readFileSync(path, "utf8"), systemClock.now());
  if (errors.length > 0) {
    for (const { line, message } of errors) console.error(`line ${line}: ${message}`);
    throw new Error(
      `${errors.length} bad row(s), so nothing was imported. Fix them and run again.`,
    );
  }
  if (replace && rows.length === 0) {
    throw new Error(
      "The list is empty, so --replace would remove every earlier application. Nothing was changed.",
    );
  }
  const { db, where } = target === "local" ? await localDb() : await productionDb();
  try {
    if (replace) {
      const { removed, inserted, updated, alreadyThere } = await replaceEarlier(
        { db, clock: systemClock },
        rows,
      );
      console.log(
        `In ${where}: removed ${removed} row(s) the file no longer has, imported ${inserted} new, corrected ${updated}, and ${alreadyThere} were already there.`,
      );
      return;
    }
    const { inserted, updated, alreadyThere } = await importEarlier(
      { db, clock: systemClock },
      rows,
    );
    console.log(
      `Into ${where}: imported ${inserted} new row(s), corrected ${updated}, and ${alreadyThere} were already there.`,
    );
  } finally {
    await db.close();
  }
}

async function localDb(): Promise<{ db: Db & { close(): Promise<void> }; where: string }> {
  const db = await openLocalDb(join(process.cwd(), ".data"), {
    schema: SCHEMA,
    holder: "npm run ledger:import",
  });
  await bootstrapForTests(db);
  await applyMigrations(db, loadMigrations(join(process.cwd(), "db", "migrations")));
  return { db, where: "the local database" };
}

async function productionDb(): Promise<{ db: Db & { close(): Promise<void> }; where: string }> {
  const env = loadOpsEnv();
  requireValues(env, ["DATABASE_URL", "SUPABASE_URL"]);
  const ref = productionRef(env);
  await confirmProduction(ref, askOnTerminal);
  const db = createPgDb({ connectionString: env.DATABASE_URL!, schema: SCHEMA, max: 1 });
  return { db, where: `production (${ref})` };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
