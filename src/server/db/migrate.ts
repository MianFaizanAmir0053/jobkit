/**
 * Forward-only SQL migrations (platform spec B1): `db/migrations/NNNN_name.sql`,
 * applied in order, each in its own transaction, and recorded in
 * `{{schema}}.schema_migrations`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "@/core/ports";

export interface Migration {
  version: string;
  sql: string;
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      version: file.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, file), "utf8"),
    }));
}

/** What the production bootstrap does for the app role, done as PGlite's superuser in tests. */
export async function bootstrapForTests(db: Db): Promise<void> {
  await db.exec("create schema if not exists {{schema}}");
}

/** Applies the migrations not yet recorded and returns their versions, in order. */
export async function applyMigrations(db: Db, migrations: readonly Migration[]): Promise<string[]> {
  await db.exec(`
    create table if not exists {{schema}}.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
    alter table {{schema}}.schema_migrations enable row level security;
  `);
  const done = new Set(
    (
      await db.query<{ version: string }>("select version from {{schema}}.schema_migrations")
    ).rows.map((row) => row.version),
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    await db.tx(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query("insert into {{schema}}.schema_migrations (version) values ($1)", [
        migration.version,
      ]);
    });
    applied.push(migration.version);
  }
  return applied;
}
