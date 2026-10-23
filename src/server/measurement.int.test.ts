import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { TEST_MODE_MS, testModeUntil } from "@/core/ledger/testMode";
import { issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { testMode } from "./measurement";

/* Test mode's route (ledger spec, "Test jobs"; platform AC9). */

const ORIGIN = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
let clock: FakeClock;
const deps = () => ({ db, clock, config });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.measurement; delete from {{schema}}.sessions;");
  clock = fakeClock();
});

async function signedIn(kind: "google" | "paired"): Promise<string> {
  const { token } = await issueSession({ db, clock, random: cryptoRandom }, { kind, label: kind });
  await db.exec("update {{schema}}.sessions set approved_at = created_at");
  return token;
}

function post(cookie: string | undefined, body: unknown, origin = ORIGIN): NextRequest {
  const headers: Record<string, string> = { origin };
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}/api/measurement/test-mode`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/measurement/test-mode", () => {
  it("turns test mode on for an hour from the phone, then off, and it ends by itself", async () => {
    const cookie = await signedIn("paired");

    const on = await testMode(post(cookie, { on: true }), deps());
    expect(on.status).toBe(200);
    const until = new Date(clock.now().getTime() + TEST_MODE_MS);
    expect(await on.json()).toEqual({ until: until.toISOString() });
    expect(await testModeUntil(deps())).toEqual(until);

    const off = await testMode(post(cookie, { on: false }), deps());
    expect(await off.json()).toEqual({ until: null });
    expect(await testModeUntil(deps())).toBeNull();

    // Left on, it is off once the hour is up.
    await testMode(post(cookie, { on: true }), deps());
    clock.advance(TEST_MODE_MS);
    expect(await testModeUntil(deps())).toBeNull();
  });

  it("refuses another origin, no session and a body that says nothing, changing nothing", async () => {
    const cookie = await signedIn("google");

    expect(
      (await testMode(post(cookie, { on: true }, "https://evil.example"), deps())).status,
    ).toBe(403);
    expect((await testMode(post(undefined, { on: true }), deps())).status).toBe(401);
    expect((await testMode(post(cookie, { on: "yes" }), deps())).status).toBe(400);
    expect(await testModeUntil(deps())).toBeNull();
  });
});
