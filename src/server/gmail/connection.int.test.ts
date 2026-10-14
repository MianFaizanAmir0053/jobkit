import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import {
  forgetGmailConnection,
  gmailConnection,
  gmailRefreshToken,
  keepGmailConnection,
  markGmailRefused,
} from "./connection";

/* The owner's Gmail connection, kept with its refresh token sealed (decisions A20). */

let db: PgliteDb;
const clock = fakeClock();
const key = randomBytes(32);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.gmail_connection");
});

describe("the Gmail connection", () => {
  it("keeps the account and its scopes, with the refresh token sealed", async () => {
    await keepGmailConnection({ db, clock }, key, {
      email: "owner@example.com",
      refreshToken: "fixture-refresh-token",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.send"],
    });

    expect(await gmailConnection(db)).toEqual({
      email: "owner@example.com",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.send"],
      connectedAt: clock.now(),
      refusedAt: null,
    });
    const { rows } = await db.query<{ refresh_token_sealed: string }>(
      "select refresh_token_sealed from {{schema}}.gmail_connection",
    );
    expect(rows[0]!.refresh_token_sealed).not.toContain("fixture-refresh-token");
    expect(await gmailRefreshToken(db, key)).toBe("fixture-refresh-token");
  });

  it("keeps one connection: connecting again replaces it", async () => {
    await keepGmailConnection({ db, clock }, key, {
      email: "owner@example.com",
      refreshToken: "first",
      scopes: [],
    });
    await keepGmailConnection({ db, clock }, key, {
      email: "owner@example.com",
      refreshToken: "second",
      scopes: [],
    });

    expect(await gmailRefreshToken(db, key)).toBe("second");
  });

  it("gives no token without a connection, or under another key, and forgets it on disconnect", async () => {
    expect(await gmailConnection(db)).toBeNull();
    expect(await gmailRefreshToken(db, key)).toBeNull();
    await keepGmailConnection({ db, clock }, key, {
      email: "owner@example.com",
      refreshToken: "fixture-refresh-token",
      scopes: [],
    });

    expect(await gmailRefreshToken(db, randomBytes(32))).toBeNull();
    await forgetGmailConnection(db);
    expect(await gmailConnection(db)).toBeNull();
    expect(await gmailRefreshToken(db, key)).toBeNull();
    // Forgetting a connection that is gone changes nothing.
    await forgetGmailConnection(db);
  });

  it("records when Google refused the connection, until it is connected again", async () => {
    const connection = { email: "owner@example.com", refreshToken: "first", scopes: [] };
    await keepGmailConnection({ db, clock }, key, connection);

    await markGmailRefused({ db, clock });
    expect((await gmailConnection(db))!.refusedAt).toEqual(clock.now());

    await keepGmailConnection({ db, clock }, key, { ...connection, refreshToken: "second" });
    expect((await gmailConnection(db))!.refusedAt).toBeNull();
  });
});
