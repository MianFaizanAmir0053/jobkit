import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { findSession, issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { signOut } from "./signOut";

const ORIGIN = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
const clock = fakeClock();

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.sessions");
});

function signOutRequest(token: string, origin: string | null): NextRequest {
  const headers: Record<string, string> = { cookie: `jobkit_session=${token}` };
  if (origin !== null) headers.origin = origin;
  return new NextRequest(`${ORIGIN}/api/auth/signout`, { method: "POST", headers });
}

describe("signOut", () => {
  it("deletes the session's row, clears the cookie and goes to the sign-in page", async () => {
    const { token } = await issueSession(
      { db, clock, random: cryptoRandom },
      {
        kind: "google",
        label: "laptop",
      },
    );

    const response = await signOut(signOutRequest(token, ORIGIN), { db, config });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
    expect(response.headers.getSetCookie().join("\n")).toMatch(/jobkit_session=;.*Max-Age=0/);
    expect(await findSession({ db, clock }, token)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a request from a foreign origin, or with no origin, and keeps the session", async () => {
    const { token } = await issueSession(
      { db, clock, random: cryptoRandom },
      {
        kind: "google",
        label: "laptop",
      },
    );

    for (const origin of ["https://evil.example", "http://localhost:3001", null]) {
      const response = await signOut(signOutRequest(token, origin), { db, config });

      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await findSession({ db, clock }, token)).toMatchObject({ ok: true });
  });
});
