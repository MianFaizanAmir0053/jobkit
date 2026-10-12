import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { createTestDb } from "@/server/db/testDb";

import { createJob, loadJob } from "./jobs";
import { dailyMaintenance, keepAlive } from "./maintenance";
import { createPairingToken, redeemPairingToken } from "./pairing";
import { findSession, issueSession } from "./sessions";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let db: PgliteDb;
let clock: FakeClock;
const deps = () => ({ db, clock, random: cryptoRandom });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.sessions; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs`,
  );
  clock = fakeClock();
});

async function heartbeat(): Promise<Date> {
  const { rows } = await db.query<{ touched_at: Date }>(
    "select touched_at from {{schema}}.heartbeat",
  );
  return rows[0]!.touched_at;
}

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from {{schema}}.${table}`,
  );
  return rows[0]!.n;
}

describe("keepAlive", () => {
  it("touches the heartbeat and nothing else", async () => {
    const { token } = await issueSession(deps(), { kind: "google", label: "laptop" });
    clock.advance(DAY);

    await keepAlive(deps());

    expect(await heartbeat()).toEqual(clock.now());
    expect(await count("sessions")).toBe(1);
    expect(await findSession(deps(), token)).toMatchObject({ ok: true });
  });
});

describe("dailyMaintenance", () => {
  it("touches the heartbeat, deletes phones left waiting, ended sessions and old tokens", async () => {
    const ended = await issueSession(deps(), { kind: "google", label: "old laptop" });
    clock.advance(30 * DAY - 10 * MINUTE);
    const laptop = await issueSession(deps(), { kind: "google", label: "laptop" });
    const made = await createPairingToken(deps(), laptop.session);
    if (!made.ok) throw new Error("expected a token");
    await redeemPairingToken(deps(), made.token, "phone");
    clock.advance(10 * MINUTE);

    const result = await dailyMaintenance(deps());

    expect(result).toEqual({
      expiredPairings: 1,
      endedSessions: 1,
      oldPairingTokens: 0,
      expiredUploads: 0,
    });
    expect(await heartbeat()).toEqual(clock.now());
    expect(await findSession(deps(), ended.token)).toEqual({ ok: false, reason: "missing" });
    expect(await findSession(deps(), laptop.token)).toMatchObject({ ok: true });

    clock.advance(DAY);
    expect((await dailyMaintenance(deps())).oldPairingTokens).toBe(1);
  });

  it("changes nothing more when run twice, since Vercel may deliver a run twice", async () => {
    await issueSession(deps(), { kind: "google", label: "laptop" });

    const first = await dailyMaintenance(deps());
    const second = await dailyMaintenance(deps());

    expect(first).toEqual({
      expiredPairings: 0,
      endedSessions: 0,
      oldPairingTokens: 0,
      expiredUploads: 0,
    });
    expect(second).toEqual(first);
    expect(await count("sessions")).toBe(1);
  });

  it("moves uploads left unfinished for 15 minutes to upload_failed, the backstop for status reads", async () => {
    const stale = await createJob(db, {
      state: "uploading",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    clock.advance(15 * MINUTE);
    const fresh = await createJob(db, {
      state: "uploading",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });

    expect((await dailyMaintenance(deps())).expiredUploads).toBe(1);

    expect(await loadJob(db, stale)).toMatchObject({ state: "upload_failed" });
    expect(await loadJob(db, fresh)).toMatchObject({ state: "uploading" });
  });
});
