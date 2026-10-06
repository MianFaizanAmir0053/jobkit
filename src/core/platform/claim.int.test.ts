import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPgliteDb, type PgliteDb } from "@/adapters/pglite";

import { claimOne } from "./claim";

const CLAIM_TOKEN_1 =
  "update {{schema}}.tokens set used_by = $1 where id = 1 and used_by is null returning id";

let db: PgliteDb;

beforeEach(async () => {
  db = await createPgliteDb({ schema: "jobkit" });
  await db.exec(`
    create schema {{schema}};
    create table {{schema}}.tokens (id int primary key, used_by text);
    insert into {{schema}}.tokens (id) values (1), (2);
  `);
});

afterEach(async () => {
  await db.close();
});

async function usedBy(): Promise<unknown[]> {
  const { rows } = await db.query<{ used_by: string | null }>(
    "select used_by from {{schema}}.tokens order by id",
  );
  return rows.map((r) => r.used_by);
}

describe("claimOne", () => {
  it("returns the row it claimed", async () => {
    expect(await claimOne<{ id: number }>(db, CLAIM_TOKEN_1, ["a"])).toEqual({ id: 1 });
    expect(await usedBy()).toEqual(["a", null]);
  });

  it("returns null when another request claimed the row first", async () => {
    await claimOne(db, CLAIM_TOKEN_1, ["a"]);

    expect(await claimOne(db, CLAIM_TOKEN_1, ["b"])).toBeNull();
    expect(await usedBy()).toEqual(["a", null]);
  });

  it("undoes a claim that touched more than one row, because its WHERE clause lacks a key", async () => {
    const tooBroad = "update {{schema}}.tokens set used_by = $1 where used_by is null returning id";

    await expect(claimOne(db, tooBroad, ["a"])).rejects.toThrow(/at most one row/);
    expect(await usedBy()).toEqual([null, null]);
  });

  it("refuses SQL without RETURNING, which would report a won claim as lost", async () => {
    const noReturning =
      "update {{schema}}.tokens set used_by = $1 where id = 1 and used_by is null";

    await expect(claimOne(db, noReturning, ["a"])).rejects.toThrow(/RETURNING/);
    expect(await usedBy()).toEqual([null, null]);
  });

  it("runs inside the caller's transaction, so a later failure there undoes the claim too", async () => {
    await expect(
      db.tx(async (tx) => {
        await claimOne(tx, CLAIM_TOKEN_1, ["a"]);
        throw new Error("the session insert failed");
      }),
    ).rejects.toThrow(/session insert/);
    expect(await usedBy()).toEqual([null, null]);
  });
});
