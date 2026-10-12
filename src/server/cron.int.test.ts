import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import { daily, keepalive, type CronSecrets } from "./cron";

const secrets: CronSecrets = {
  cron: "fixture-cron-secret-for-tests-0001",
  keepalive: "fixture-keepalive-secret-for-tests-0002",
};

let db: PgliteDb;
const clock = fakeClock();

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function call(path: string, authorization?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

describe("GET /api/cron/keepalive", () => {
  it("accepts only the keep-alive secret", async () => {
    const run = (authorization?: string) =>
      keepalive(call("/api/cron/keepalive", authorization), { db, clock, secrets });

    expect((await run(`Bearer ${secrets.keepalive}`)).status).toBe(200);
    for (const wrong of [
      undefined,
      "",
      `Bearer ${secrets.cron}`,
      secrets.keepalive,
      `bearer ${secrets.keepalive}`,
      `Bearer ${secrets.keepalive}x`,
    ]) {
      expect((await run(wrong)).status).toBe(401);
    }
  });
});

describe("GET /api/cron/daily", () => {
  it("accepts only the cron secret, and reports what it did", async () => {
    const run = (authorization?: string) =>
      daily(call("/api/cron/daily", authorization), { db, clock, secrets });

    const accepted = await run(`Bearer ${secrets.cron}`);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      expiredPairings: 0,
      endedSessions: 0,
      oldPairingTokens: 0,
      expiredUploads: 0,
    });
    expect((await run(`Bearer ${secrets.keepalive}`)).status).toBe(401);
    expect((await run()).status).toBe(401);
  });
});

describe("both endpoints", () => {
  it("refuse everything while their secret is unset", async () => {
    const unset = { cron: "", keepalive: "" };

    expect(
      (await keepalive(call("/api/cron/keepalive", "Bearer "), { db, clock, secrets: unset }))
        .status,
    ).toBe(401);
    expect(
      (await daily(call("/api/cron/daily", "Bearer "), { db, clock, secrets: unset })).status,
    ).toBe(401);
  });

  it("refuse everything when both secrets are the same, since each must reject the other's", async () => {
    const same = { cron: secrets.cron, keepalive: secrets.cron };
    const bearer = `Bearer ${secrets.cron}`;

    expect(
      (await keepalive(call("/api/cron/keepalive", bearer), { db, clock, secrets: same })).status,
    ).toBe(401);
    expect(
      (await daily(call("/api/cron/daily", bearer), { db, clock, secrets: same })).status,
    ).toBe(401);
  });
});
