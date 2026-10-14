import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { gmailConnection, keepGmailConnection } from "./connection";
import { connectedGmail, testGmail } from "./sender";

/* The owner's connected Gmail as a sender, and a connection Google refused (decisions A20). */

let db: PgliteDb;
const clock = fakeClock();
const key = randomBytes(32);
const config: AppConfig = {
  appOrigin: "http://localhost:3000",
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};
const env = { GMAIL_TOKEN_KEY: key.toString("base64") };

const connect = () =>
  keepGmailConnection({ db, clock }, key, {
    email: "owner@example.com",
    refreshToken: "fixture-refresh-token",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
  });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.gmail_connection");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectedGmail", () => {
  it("gives no sender while Gmail is not connected, and the fake on the test server", async () => {
    expect(await connectedGmail({ db, clock, kind: "development", config, env })).toBeNull();

    await connect();

    expect(await connectedGmail({ db, clock, kind: "test", config, env })).toBe(testGmail());
  });

  it("records the connection as refused when Google refuses its token", async () => {
    await connect();
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const gmail = await connectedGmail({ db, clock, kind: "development", config, env });

    expect(await gmail!.send("MIME-Version: 1.0\r\n\r\n")).toMatchObject({
      ok: false,
      reason: "unauthorised",
    });
    expect((await gmailConnection(db))!.refusedAt).toEqual(clock.now());
  });

  it("records the connection as refused when the key cannot open its token", async () => {
    await connect();
    const otherKey = { GMAIL_TOKEN_KEY: randomBytes(32).toString("base64") };

    expect(
      await connectedGmail({ db, clock, kind: "development", config, env: otherKey }),
    ).toBeNull();
    expect((await gmailConnection(db))!.refusedAt).toEqual(clock.now());
  });
});
