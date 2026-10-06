import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { findSession, issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { revoke } from "./devices";

const ORIGIN = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
const clock = fakeClock();
const deps = () => ({ db, clock, random: cryptoRandom, config });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.sessions");
});

function revokeRequest(sessionId: string, cookie: string, origin = ORIGIN): NextRequest {
  return new NextRequest(`${ORIGIN}/api/devices/revoke`, {
    method: "POST",
    headers: { origin, cookie: `jobkit_session=${cookie}` },
    body: JSON.stringify({ sessionId }),
  });
}

async function devices() {
  const laptop = await issueSession(deps(), { kind: "google", label: "laptop" });
  const phone = await issueSession(deps(), { kind: "paired", label: "phone" });
  await db.query("update {{schema}}.sessions set approved_at = created_at where id = $1", [
    phone.session.id,
  ]);
  return { laptop, phone };
}

describe("POST /api/devices/revoke", () => {
  it("lets a google session revoke another; the revoked session's next request is refused", async () => {
    const { laptop, phone } = await devices();

    const response = await revoke(revokeRequest(phone.session.id, laptop.token), deps());

    expect(response.status).toBe(204);
    expect(await findSession(deps(), phone.token)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a paired session and a foreign origin", async () => {
    const { laptop, phone } = await devices();

    const fromPhone = await revoke(revokeRequest(laptop.session.id, phone.token), deps());
    const foreign = await revoke(
      revokeRequest(phone.session.id, laptop.token, "https://evil.example"),
      deps(),
    );

    expect([fromPhone.status, foreign.status]).toEqual([403, 403]);
    expect(await findSession(deps(), laptop.token)).toMatchObject({ ok: true });
    expect(await findSession(deps(), phone.token)).toMatchObject({ ok: true });
  });

  it("answers 404 for its own session, an unknown one, and 400 for a malformed body", async () => {
    const { laptop } = await devices();

    const own = await revoke(revokeRequest(laptop.session.id, laptop.token), deps());
    const unknown = await revoke(
      revokeRequest("00000000-0000-4000-8000-000000000000", laptop.token),
      deps(),
    );
    const malformed = await revoke(revokeRequest("not-an-id", laptop.token), deps());

    expect([own.status, unknown.status, malformed.status]).toEqual([404, 404, 400]);
  });
});
