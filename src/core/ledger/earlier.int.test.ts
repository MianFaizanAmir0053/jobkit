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

  it("keeps a corrected row's import time unless its address changed, since only that can find new matches", async () => {
    await importEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows);
    const importedAt = clock.now();
    clock.advance(60_000);
    const corrected = CSV.replace(
      "Globex,Designer,2026-06-01,form",
      "Globex,Designer,2026-06-01,message",
    );

    expect(await importEarlier(deps(), parseEarlierCsv(corrected, clock.now()).rows)).toMatchObject(
      { updated: 1 },
    );
    const { rows } = await db.query(
      `select route, imported_at from {{schema}}.earlier_applications where applied_on = '2026-06-01'`,
    );
    expect(rows).toEqual([{ route: "message", imported_at: importedAt }]);
  });
});

describe("replaceEarlier", () => {
  it("replaces the whole list, so a row fixed in a way that changes its key leaves no stale copy", async () => {
    await importEarlier(
      deps(),
      parseEarlierCsv(CSV.replace("Frontend Developer", "Fronted Developer"), clock.now()).rows,
    );

    expect(await replaceEarlier(deps(), parseEarlierCsv(CSV, clock.now()).rows)).toEqual({
      removed: 2,
      inserted: 2,
    });
    const { rows } = await db.query<{ role: string }>(
      "select role from {{schema}}.earlier_applications order by applied_on",
    );
    expect(rows.map((row) => row.role)).toEqual(["Frontend Developer", "Designer"]);
  });
});
