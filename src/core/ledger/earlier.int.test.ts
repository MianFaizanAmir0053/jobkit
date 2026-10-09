import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import { importEarlier, parseEarlierCsv, replaceEarlier } from "./earlier";
import { companyRoleHash } from "./normalise";

let db: PgliteDb;
let clock: FakeClock;
const deps = () => ({ db, clock });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.earlier_applications");
  clock = fakeClock(new Date("2026-10-15T12:00:00Z"));
});

const CSV = [
  "company,role,applied_on,route,address",
  "Acme Ltd,Frontend Developer,2026-05-04,email,jobs@acme.example",
  "Globex,Designer,2026-06-01,form",
].join("\n");

describe("importEarlier", () => {
  it("stores each row with its company-role hash", async () => {
    await importEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows);

    const { rows } = await db.query(
      `select company, role, company_role_hash, applied_on::text as applied_on, route, address, imported_at
         from {{schema}}.earlier_applications order by applied_on`,
    );
    expect(rows).toEqual([
      {
        company: "Acme Ltd",
        role: "Frontend Developer",
        company_role_hash: companyRoleHash("Acme Ltd", "Frontend Developer"),
        applied_on: "2026-05-04",
        route: "email",
        address: "jobs@acme.example",
        imported_at: clock.now(),
      },
      expect.objectContaining({ company: "Globex", applied_on: "2026-06-01", address: null }),
    ]);
  });

  it("adds nothing when the same list is imported twice", async () => {
    const rows = parseEarlierCsv(CSV, clock.now()).rows;

    expect(await importEarlier(deps(), rows)).toEqual({ inserted: 2, updated: 0, alreadyThere: 0 });
    expect(await importEarlier(deps(), rows)).toEqual({ inserted: 0, updated: 0, alreadyThere: 2 });
  });

  it("corrects a row when a later list changes its route, address or spelling, as of the new import", async () => {
    await importEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows);
    clock.advance(60_000);
    const corrected = CSV.replace(
      "Globex,Designer,2026-06-01,form",
      "GLOBEX,Designer,2026-06-01,email,hr@globex.example",
    );

    expect(await importEarlier(deps(), parseEarlierCsv(corrected, clock.now()).rows)).toEqual({
      inserted: 0,
      updated: 1,
      alreadyThere: 1,
    });
    const { rows } = await db.query(
      `select company, route, address, imported_at from {{schema}}.earlier_applications where applied_on = '2026-06-01'`,
    );
    expect(rows).toEqual([
      { company: "GLOBEX", route: "email", address: "hr@globex.example", imported_at: clock.now() },
    ]);
  });

  it("re-keys a row stored under older rules, so importing it again adds nothing", async () => {
    await db.query(
      `insert into {{schema}}.earlier_applications
         (company, role, company_role_hash, applied_on, route, address, imported_at)
       values ('Acme Ltd', 'Frontend Developer', 'stale', '2026-05-04', 'email', 'jobs@acme.example', $1)`,
      [clock.now()],
    );

    expect(await importEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows)).toEqual({
      inserted: 1,
      updated: 0,
      alreadyThere: 1,
    });
    const { rows } = await db.query<{ company_role_hash: string }>(
      "select company_role_hash from {{schema}}.earlier_applications where applied_on = '2026-05-04'",
    );
    expect(rows).toEqual([
      { company_role_hash: companyRoleHash("Acme Ltd", "Frontend Developer") },
    ]);
  });
});

describe("replaceEarlier", () => {
  it("removes the rows the file no longer has and keeps the rest as they were", async () => {
    await importEarlier(
      deps(),
      parseEarlierCsv(CSV.replace("Frontend Developer", "Fronted Developer"), clock.now()).rows,
    );
    const before = await db.query<{ id: string }>(
      "select id from {{schema}}.earlier_applications where company = 'Globex'",
    );

    expect(await replaceEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows)).toEqual({
      removed: 1,
      inserted: 1,
      updated: 0,
      alreadyThere: 1,
    });
    const { rows } = await db.query<{ id: string; role: string }>(
      "select id, role from {{schema}}.earlier_applications order by applied_on",
    );
    expect(rows.map((row) => row.role)).toEqual(["Frontend Developer", "Designer"]);
    expect(rows[1]!.id).toBe(before.rows[0]!.id);
  });

  it("refuses an empty list, which would remove every earlier application", async () => {
    await importEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows);

    await expect(replaceEarlier(deps(), [])).rejects.toThrow(/empty/);
    const { rows } = await db.query("select 1 from {{schema}}.earlier_applications");
    expect(rows).toHaveLength(2);
  });
});
