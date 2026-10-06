import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { createTestDb } from "@/server/db/testDb";

import {
  checkRequirements,
  endSession,
  findSession,
  hashToken,
  issueSession,
  reauthenticate,
  remainingSeconds,
  type SessionDeps,
} from "./sessions";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: PgliteDb;
let clock: FakeClock;
let deps: SessionDeps;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.sessions");
  clock = fakeClock();
  deps = { db, clock, random: cryptoRandom };
});

async function approve(id: string): Promise<void> {
  await db.query("update {{schema}}.sessions set approved_at = $2 where id = $1", [
    id,
    clock.now(),
  ]);
}

describe("issueSession", () => {
  it("stores only the token's SHA-256 hash, never the token", async () => {
    const { token, session } = await issueSession(deps, {
      kind: "google",
      label: "Windows · Chrome",
    });

    const { rows } = await db.query("select * from {{schema}}.sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(session.label).toBe("Windows · Chrome");
  });

  it("makes a token of 32 random bytes, different every time", async () => {
    const a = await issueSession(deps, { kind: "google", label: "a" });
    const b = await issueSession(deps, { kind: "google", label: "b" });

    expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
  });

  it("approves a google session at once and stamps its Google sign-in", async () => {
    const { session } = await issueSession(deps, { kind: "google", label: "laptop" });

    expect(session.approvedAt).toEqual(clock.now());
    expect(session.googleAuthAt).toEqual(clock.now());
  });

  it("leaves a paired session waiting for approval", async () => {
    const { token } = await issueSession(deps, { kind: "paired", label: "phone" });

    expect(await findSession(deps, token)).toEqual({ ok: false, reason: "unapproved" });
  });
});

describe("findSession", () => {
  it("finds a live session by its token", async () => {
    const issued = await issueSession(deps, { kind: "google", label: "laptop" });

    const found = await findSession(deps, issued.token);

    expect(found).toEqual({ ok: true, session: issued.session });
  });

  it("refuses a missing or unknown token", async () => {
    expect(await findSession(deps, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await findSession(deps, "not-a-token")).toEqual({ ok: false, reason: "missing" });
  });

  it("ends a google session 30 days after it was made, however often it is used", async () => {
    const { token } = await issueSession(deps, { kind: "google", label: "laptop" });

    for (let day = 0; day < 29; day++) {
      clock.advance(DAY);
      expect((await findSession(deps, token)).ok).toBe(true);
    }
    clock.advance(DAY - 1);
    expect((await findSession(deps, token)).ok).toBe(true);
    clock.advance(1);
    expect(await findSession(deps, token)).toEqual({ ok: false, reason: "expired" });
  });

  it("ends a paired session 180 days after it was made, however often it is used", async () => {
    const { token, session } = await issueSession(deps, { kind: "paired", label: "phone" });
    await approve(session.id);

    clock.advance(90 * DAY);
    expect((await findSession(deps, token)).ok).toBe(true);
    clock.advance(90 * DAY - 1);
    expect((await findSession(deps, token)).ok).toBe(true);
    clock.advance(1);
    expect(await findSession(deps, token)).toEqual({ ok: false, reason: "expired" });
  });

  it("updates last_seen_at at most once an hour", async () => {
    const { token } = await issueSession(deps, { kind: "google", label: "laptop" });
    const lastSeen = async () =>
      (await db.query<{ last_seen_at: Date }>("select last_seen_at from {{schema}}.sessions"))
        .rows[0]!.last_seen_at;
    const madeAt = clock.now();

    clock.advance(59 * MINUTE);
    await findSession(deps, token);
    expect(await lastSeen()).toEqual(madeAt);

    clock.advance(MINUTE);
    const found = await findSession(deps, token);
    expect(await lastSeen()).toEqual(clock.now());
    expect(found.ok && found.session.lastSeenAt).toEqual(clock.now());
  });
});

describe("checkRequirements", () => {
  it("accepts a session of the required kind", async () => {
    const { session } = await issueSession(deps, { kind: "google", label: "laptop" });

    expect(checkRequirements(session, clock.now(), { kind: "google" })).toEqual({
      ok: true,
      session,
    });
  });

  it("refuses a session of another kind", async () => {
    const { session } = await issueSession(deps, { kind: "paired", label: "phone" });

    expect(checkRequirements(session, clock.now(), { kind: "google" })).toEqual({
      ok: false,
      reason: "wrong-kind",
    });
  });

  it("asks for a fresh Google sign-in once the last one is older than the window", async () => {
    const { session } = await issueSession(deps, { kind: "google", label: "laptop" });
    const fiveMinutes = { kind: "google", googleAuthWithinMs: 5 * MINUTE } as const;

    expect(
      checkRequirements(session, new Date(clock.now().getTime() + 5 * MINUTE), fiveMinutes),
    ).toMatchObject({ ok: true });
    expect(
      checkRequirements(session, new Date(clock.now().getTime() + 5 * MINUTE + 1), fiveMinutes),
    ).toEqual({ ok: false, reason: "stale-google-auth" });
  });

  it("never counts a paired session as recently signed in with Google", async () => {
    const { session } = await issueSession(deps, { kind: "paired", label: "phone" });

    expect(checkRequirements(session, clock.now(), { googleAuthWithinMs: 5 * MINUTE })).toEqual({
      ok: false,
      reason: "stale-google-auth",
    });
  });
});

describe("reauthenticate", () => {
  it("renews the Google sign-in and rotates the token on the same row; the old token stops working", async () => {
    const first = await issueSession(deps, { kind: "google", label: "laptop" });
    clock.advance(10 * DAY);

    const renewed = await reauthenticate(deps, first.session.id);

    expect(renewed).not.toBeNull();
    expect(renewed!.session.id).toBe(first.session.id);
    expect(renewed!.token).not.toBe(first.token);
    expect(renewed!.session.googleAuthAt).toEqual(clock.now());
    expect(await findSession(deps, first.token)).toEqual({ ok: false, reason: "missing" });
    expect(await findSession(deps, renewed!.token)).toMatchObject({ ok: true });
    expect((await db.query("select id from {{schema}}.sessions")).rows).toHaveLength(1);
  });

  it("keeps the lifetime absolute: renewing never moves the end date", async () => {
    const first = await issueSession(deps, { kind: "google", label: "laptop" });
    clock.advance(29 * DAY);

    const renewed = await reauthenticate(deps, first.session.id);

    expect(renewed!.session.expiresAt).toEqual(first.session.expiresAt);
    expect(remainingSeconds(renewed!.session, clock.now())).toBe(DAY / 1000);
  });

  it("refuses an expired, deleted or paired session", async () => {
    const expired = await issueSession(deps, { kind: "google", label: "old" });
    const paired = await issueSession(deps, { kind: "paired", label: "phone" });
    await approve(paired.session.id);
    clock.advance(30 * DAY);

    expect(await reauthenticate(deps, expired.session.id)).toBeNull();
    expect(await reauthenticate(deps, paired.session.id)).toBeNull();
    expect(await reauthenticate(deps, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("endSession", () => {
  it("deletes the session the token belongs to, and only that one", async () => {
    const mine = await issueSession(deps, { kind: "google", label: "laptop" });
    const other = await issueSession(deps, { kind: "google", label: "other" });

    await endSession(db, mine.token);

    expect(await findSession(deps, mine.token)).toEqual({ ok: false, reason: "missing" });
    expect(await findSession(deps, other.token)).toMatchObject({ ok: true });
  });
});

describe("remainingSeconds", () => {
  it("gives the cookie's Max-Age: the whole seconds left until the absolute end", async () => {
    const { session } = await issueSession(deps, { kind: "google", label: "laptop" });

    expect(remainingSeconds(session, clock.now())).toBe((30 * DAY) / 1000);
    expect(remainingSeconds(session, new Date(session.expiresAt.getTime() + 1))).toBe(0);
  });
});
