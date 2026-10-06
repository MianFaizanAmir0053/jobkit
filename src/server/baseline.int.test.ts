import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { baselineSummary } from "@/core/ledger/baseline";
import { issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { discard, start, stop } from "./baseline";

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
  await db.exec("delete from {{schema}}.baseline_runs; delete from {{schema}}.sessions;");
  clock = fakeClock();
});

async function signedIn(kind: "google" | "paired" = "google"): Promise<string> {
  const { token } = await issueSession({ db, clock, random: cryptoRandom }, { kind, label: kind });
  await db.exec("update {{schema}}.sessions set approved_at = created_at");
  return token;
}

function post(path: string, cookie?: string, body?: unknown, origin = ORIGIN): NextRequest {
  const headers: Record<string, string> = { origin };
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("the baseline routes", () => {
  it("start, then stop with the route, company and role", async () => {
    const cookie = await signedIn();

    const started = await start(post("/api/baseline/start", cookie), deps());
    clock.advance(90_000);
    const stopped = await stop(
      post("/api/baseline/stop", cookie, { route: "email", company: "Contoso", role: "Engineer" }),
      deps(),
    );

    expect(started.status).toBe(201);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ durationMs: 90_000 });
    expect((await baselineSummary(deps())).count).toBe(1);
  });

  it("work from a paired phone too, since the owner may apply from it", async () => {
    const phone = await signedIn("paired");

    expect((await start(post("/api/baseline/start", phone), deps())).status).toBe(201);
  });

  it("say when a stopwatch is already running, or none is", async () => {
    const cookie = await signedIn();
    await start(post("/api/baseline/start", cookie), deps());

    const again = await start(post("/api/baseline/start", cookie), deps());
    await discard(post("/api/baseline/discard", cookie), deps());
    const nothingToStop = await stop(
      post("/api/baseline/stop", cookie, { route: "form", company: "Contoso", role: "Engineer" }),
      deps(),
    );
    const nothingToDiscard = await discard(post("/api/baseline/discard", cookie), deps());

    expect([again.status, nothingToStop.status, nothingToDiscard.status]).toEqual([409, 409, 409]);
  });

  it("refuse a malformed or empty stop, keeping the stopwatch running", async () => {
    const cookie = await signedIn();
    await start(post("/api/baseline/start", cookie), deps());

    for (const body of [
      { route: "fax", company: "Contoso", role: "Engineer" },
      { route: "email", company: " ", role: "Engineer" },
      undefined,
    ]) {
      expect((await stop(post("/api/baseline/stop", cookie, body), deps())).status).toBe(400);
    }
    expect((await baselineSummary(deps())).running).not.toBeNull();
  });

  it("refuse a foreign origin and a request without a session", async () => {
    const cookie = await signedIn();

    const foreign = await start(
      post("/api/baseline/start", cookie, undefined, "https://evil.example"),
      deps(),
    );
    const signedOut = await start(post("/api/baseline/start"), deps());

    expect([foreign.status, signedOut.status]).toEqual([403, 401]);
    expect((await baselineSummary(deps())).running).toBeNull();
  });
});
