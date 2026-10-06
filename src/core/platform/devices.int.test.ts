import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { createTestDb } from "@/server/db/testDb";

import { listDevices, revokeSession } from "./devices";
import { findSession, issueSession } from "./sessions";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
  await db.exec("delete from {{schema}}.sessions");
  clock = fakeClock();
});

async function approvedPhone(label: string) {
  const issued = await issueSession(deps(), { kind: "paired", label });
  await db.query("update {{schema}}.sessions set approved_at = $2 where id = $1", [
    issued.session.id,
    clock.now(),
  ]);
  return issued;
}

describe("listDevices", () => {
  it("lists the live, approved sessions: this one first, then the most recently seen", async () => {
    const old = await issueSession(deps(), { kind: "google", label: "Old laptop" });
    clock.advance(2 * HOUR);
    const phone = await approvedPhone("Android · Chrome");
    clock.advance(2 * HOUR);
    const me = await issueSession(deps(), { kind: "google", label: "Windows · Chrome" });
    await issueSession(deps(), { kind: "paired", label: "Waiting phone" });

    const devices = await listDevices(deps(), me.session);

    expect(devices.map((d) => [d.label, d.current])).toEqual([
      ["Windows · Chrome", true],
      ["Android · Chrome", false],
      ["Old laptop", false],
    ]);
    expect(devices[1]).toMatchObject({ id: phone.session.id, kind: "paired" });
    expect(devices[2]!.id).toBe(old.session.id);
  });

  it("leaves out sessions that have ended", async () => {
    await issueSession(deps(), { kind: "google", label: "Ended" });
    clock.advance(30 * DAY);
    const me = await issueSession(deps(), { kind: "google", label: "Now" });

    expect((await listDevices(deps(), me.session)).map((d) => d.label)).toEqual(["Now"]);
  });
});

describe("revokeSession", () => {
  it("lets a google session revoke another session, whose token then stops working", async () => {
    const me = await issueSession(deps(), { kind: "google", label: "laptop" });
    const phone = await approvedPhone("phone");

    expect(await revokeSession(deps(), me.session, phone.session.id)).toBe(true);
    expect(await findSession(deps(), phone.token)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a paired session, which may not revoke anything", async () => {
    const laptop = await issueSession(deps(), { kind: "google", label: "laptop" });
    const phone = await approvedPhone("phone");

    expect(await revokeSession(deps(), phone.session, laptop.session.id)).toBe(false);
    expect(await findSession(deps(), laptop.token)).toMatchObject({ ok: true });
  });

  it("refuses to revoke the session asking, which signs out instead, and an unknown one", async () => {
    const me = await issueSession(deps(), { kind: "google", label: "laptop" });

    expect(await revokeSession(deps(), me.session, me.session.id)).toBe(false);
    expect(await revokeSession(deps(), me.session, "00000000-0000-0000-0000-000000000000")).toBe(
      false,
    );
    expect(await findSession(deps(), me.token)).toMatchObject({ ok: true });
  });
});
