import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import { admitOwner, type GoogleIdentity } from "./owner";

const OWNER_EMAIL = "owner@example.com";
const owner: GoogleIdentity = { sub: "1001", email: OWNER_EMAIL, emailVerified: true };

let db: PgliteDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.owner");
});

const admit = (identity: GoogleIdentity, ownerEmail = OWNER_EMAIL) =>
  admitOwner({ db, clock: fakeClock() }, identity, ownerEmail);

async function pinnedSub(): Promise<string | undefined> {
  const { rows } = await db.query<{ google_sub: string }>(
    "select google_sub from {{schema}}.owner",
  );
  return rows[0]?.google_sub;
}

describe("admitOwner", () => {
  it("admits the owner's first sign-in and pins their Google sub", async () => {
    expect(await admit(owner)).toEqual({ ok: true });
    expect(await pinnedSub()).toBe("1001");
  });

  it("admits later sign-ins that present the pinned sub", async () => {
    await admit(owner);

    expect(await admit(owner)).toEqual({ ok: true });
  });

  it("refuses a different sub after the first sign-in, even with the owner's email", async () => {
    await admit(owner);

    expect(await admit({ ...owner, sub: "2002" })).toEqual({ ok: false, reason: "wrong-account" });
    expect(await pinnedSub()).toBe("1001");
  });

  it("refuses any other Google account and pins nothing", async () => {
    expect(await admit({ sub: "3003", email: "someone@example.com", emailVerified: true })).toEqual(
      { ok: false, reason: "wrong-email" },
    );
    expect(await pinnedSub()).toBeUndefined();
  });

  it("refuses an unverified email and pins nothing", async () => {
    expect(await admit({ ...owner, emailVerified: false })).toEqual({
      ok: false,
      reason: "unverified-email",
    });
    expect(await pinnedSub()).toBeUndefined();
  });

  it("admits nobody while OWNER_EMAIL is empty", async () => {
    expect(await admit(owner, "")).toEqual({ ok: false, reason: "no-owner-email" });
    expect(await admit({ ...owner, email: "" }, "  ")).toEqual({
      ok: false,
      reason: "no-owner-email",
    });
    expect(await pinnedSub()).toBeUndefined();
  });

  it("compares email addresses without regard to case or surrounding spaces", async () => {
    expect(await admit({ ...owner, email: "Owner@Example.com" }, " owner@example.com ")).toEqual({
      ok: true,
    });
  });

  it("lets exactly one of two first sign-ins with different subs pin the owner", async () => {
    const results = await Promise.all([admit(owner), admit({ ...owner, sub: "2002" })]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(["1001", "2002"]).toContain(await pinnedSub());
  });
});
