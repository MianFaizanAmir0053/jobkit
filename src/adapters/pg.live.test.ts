/**
 * Live contract test against the real Supabase database (platform spec B1).
 * Runs only with `npm run test:live`, by hand, with .env.ops.local filled in.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, loadMigrations } from "@/server/db/migrate";

import { loadOpsEnv } from "../../scripts/ops";
import { createPgDb, type PgDb } from "./pg";

const env = loadOpsEnv();
const SCHEMA = `jobkit_live_${Date.now().toString(36)}`;
let admin: PgDb;
let app: PgDb;

beforeAll(async () => {
  admin = createPgDb({ connectionString: env.DATABASE_BOOTSTRAP_URL!, schema: SCHEMA, max: 2 });
  app = createPgDb({ connectionString: env.DATABASE_URL!, schema: SCHEMA, max: 3 });
  await admin.exec("create schema {{schema}} authorization jobkit_app");
}, 60_000);

afterAll(async () => {
  await admin.exec("drop schema if exists {{schema}} cascade");
  await Promise.all([admin.close(), app.close()]);
}, 60_000);

describe("pg through Supabase's transaction pooler", () => {
  it("runs the migrations as jobkit_app, which then reads and writes", async () => {
    await applyMigrations(app, loadMigrations(join(process.cwd(), "db", "migrations")));
    await app.query("update {{schema}}.heartbeat set touched_at = now() where id = $1", [1]);

    expect((await app.query("select id from {{schema}}.heartbeat")).rows).toEqual([{ id: 1 }]);
  }, 60_000);

  it("keeps the anon role out", async () => {
    await expect(
      admin.tx(async (tx) => {
        await tx.exec("set local role anon");
        return tx.query("select * from {{schema}}.heartbeat");
      }),
    ).rejects.toThrow(/permission denied/);
  }, 60_000);

  it("lets exactly one of two concurrent claims win", async () => {
    await app.exec("create table {{schema}}.claim_probe (id int primary key, owner text)");
    await app.query("insert into {{schema}}.claim_probe (id) values (1)");
    const claim = (who: string) =>
      app.query(
        "update {{schema}}.claim_probe set owner = $1 where id = 1 and owner is null returning owner",
        [who],
      );

    const [a, b] = await Promise.all([claim("a"), claim("b")]);

    expect(a.rowCount + b.rowCount).toBe(1);
  }, 60_000);
});
