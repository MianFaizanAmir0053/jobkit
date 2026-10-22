import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPgliteDb, type PgliteDb } from "@/adapters/pglite";

import { applyMigrations, bootstrapForTests, loadMigrations } from "./migrate";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

let db: PgliteDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("applyMigrations", () => {
  it("applies every migration to an empty database after the test bootstrap, and records each", async () => {
    db = await createPgliteDb({ schema: "jobkit" });
    await bootstrapForTests(db);

    const applied = await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

    const recorded = await db.query<{ version: string }>(
      "select version from {{schema}}.schema_migrations order by version",
    );
    expect(applied.length).toBeGreaterThan(0);
    expect(recorded.rows.map((r) => r.version)).toEqual(applied);
  });

  it("changes nothing when run again", async () => {
    db = await createPgliteDb({ schema: "jobkit" });
    await bootstrapForTests(db);
    await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

    expect(await applyMigrations(db, loadMigrations(MIGRATIONS_DIR))).toEqual([]);
  });

  it("enables row-level security on every table it creates", async () => {
    db = await createPgliteDb({ schema: "jobkit" });
    await bootstrapForTests(db);
    await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind = 'r'`,
      [db.schema],
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    expect(tables.rows.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);
  });

  it("fills the placeholder with the database's own schema name", async () => {
    db = await createPgliteDb({ schema: "jobkit_test_a1" });
    await bootstrapForTests(db);
    await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

    const schemas = await db.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname like 'jobkit%'",
    );
    expect(schemas.rows.map((r) => r.nspname)).toEqual(["jobkit_test_a1"]);
  });
});

/** The tables and indexes a migration's statements name, its comments left out. */
function namesIn(text: string): string[] {
  const sql = text.replace(/--.*$/gm, "");
  return [
    /\bcreate table(?: if not exists)?\s+([a-z_."{}]+)/gi,
    /\balter table\s+([a-z_."{}]+)/gi,
    /\breferences\s+([a-z_."{}]+)/gi,
    /\bcreate (?:unique )?index(?: if not exists)?\s+[a-z_]+\s+on\s+([a-z_."{}]+)/gi,
    /\binsert into\s+([a-z_."{}]+)/gi,
    // At a statement's start, so "for update" and "do update set" are not read as one.
    /^\s*update\s+([a-z_."{}]+)/gim,
    /^\s*delete from\s+([a-z_."{}]+)/gim,
    /\bdrop (?:table|index)(?: if exists)?\s+([a-z_."{}]+)/gi,
  ].flatMap((pattern) => [...sql.matchAll(pattern)].map((m) => m[1] ?? ""));
}

describe("the migration files", () => {
  it("name their schema only through the placeholder", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
      for (const name of namesIn(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
        if (!name.startsWith("{{schema}}.")) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
    // Each kind of statement is looked at: these would be found.
    expect(
      namesIn(
        "update jobs set state = 'closed';\ndelete from jobs;\ndrop index jobs_state;\n" +
          "drop table if exists heartbeat;\ninsert into jobs (id) values (1) on conflict do update set id = 1;",
      ),
    ).toEqual(["jobs", "jobs", "jobs", "jobs_state", "heartbeat"]);
  });
});

describe("createPgliteDb", () => {
  it("refuses a schema name that is not a plain identifier", async () => {
    await expect(createPgliteDb({ schema: "jobkit; drop table x" })).rejects.toThrow(/schema/);
  });

  it("creates missing parent folders for a data directory on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "jobkit-pglite-"));
    try {
      db = await createPgliteDb({ schema: "jobkit", dataDir: join(root, "not", "yet", "there") });
      expect((await db.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
      await db.close();
      db = undefined;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // A fresh data folder: on top of the start every PGlite database makes,
    // PGlite writes the new database to the folder, nearly a thousand files
    // one by one. The test takes about 9 seconds in a full check; the same
    // work took the failed-start test in container.int.test.ts past 30 once.
  }, 60_000);
});
