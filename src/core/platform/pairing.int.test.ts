import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { createTestDb } from "@/server/db/testDb";

import {
  approvePairing,
  createPairingToken,
  expirePendingPairings,
  pairingStatus,
  redeemPairingToken,
  rejectPairing,
  waitingPhones,
} from "./pairing";
import { findSession, hashToken, issueSession, type Session } from "./sessions";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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

async function laptop(): Promise<Session> {
  return (await issueSession(deps(), { kind: "google", label: "Windows · Chrome" })).session;
}

/** A token from a fresh laptop session, redeemed by a phone. */
async function redeemed(): Promise<{
  approver: Session;
  phoneToken: string;
  pairingId: string;
  code: string;
}> {
  const approver = await laptop();
  const made = await createPairingToken(deps(), approver);
  if (!made.ok) throw new Error("expected a token");
  const redemption = await redeemPairingToken(deps(), made.token, "Android · Chrome");
  if (!redemption.ok) throw new Error("expected a redemption");
  return {
    approver,
    phoneToken: redemption.issued.token,
    pairingId: redemption.issued.session.id,
    code: redemption.code,
  };
}

function wrong(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("createPairingToken", () => {
  it("gives a google session a 32-byte token for two minutes, storing only its hash", async () => {
    const approver = await laptop();

    const made = await createPairingToken(deps(), approver);

    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(Buffer.from(made.token, "base64url")).toHaveLength(32);
    expect(made.expiresAt).toEqual(new Date(clock.now().getTime() + 2 * MINUTE));
    const { rows } = await db.query("select * from {{schema}}.pairing_tokens");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(made.token));
    expect(JSON.stringify(rows)).not.toContain(made.token);
  });

  it("cancels the session's earlier unused codes, so only the newest QR code works", async () => {
    const approver = await laptop();
    const first = await createPairingToken(deps(), approver);
    const second = await createPairingToken(deps(), approver);
    if (!first.ok || !second.ok) throw new Error("expected tokens");

    expect(await redeemPairingToken(deps(), first.token, "phone")).toEqual({ ok: false });
    expect((await redeemPairingToken(deps(), second.token, "phone")).ok).toBe(true);
  });

  it("refuses a google session whose last Google sign-in is more than five minutes old", async () => {
    const approver = await laptop();
    clock.advance(5 * MINUTE + 1);

    expect(await createPairingToken(deps(), approver)).toEqual({
      ok: false,
      reason: "stale-google-auth",
    });
  });

  it("refuses a paired session", async () => {
    const phone = (await issueSession(deps(), { kind: "paired", label: "phone" })).session;

    expect(await createPairingToken(deps(), phone)).toEqual({ ok: false, reason: "wrong-kind" });
    expect((await db.query("select * from {{schema}}.pairing_tokens")).rows).toEqual([]);
  });
});

describe("redeemPairingToken", () => {
  it("creates a paired session that waits for approval, with a six-digit code", async () => {
    const approver = await laptop();
    const made = await createPairingToken(deps(), approver);
    if (!made.ok) throw new Error("expected a token");

    const redemption = await redeemPairingToken(deps(), made.token, "Android · Chrome");

    expect(redemption.ok).toBe(true);
    if (!redemption.ok) return;
    expect(redemption.code).toMatch(/^\d{6}$/);
    expect(redemption.issued.session).toMatchObject({
      kind: "paired",
      label: "Android · Chrome",
      approvedAt: null,
    });
    expect(await findSession(deps(), redemption.issued.token)).toEqual({
      ok: false,
      reason: "unapproved",
    });
    const pending = await db.query("select * from {{schema}}.pending_pairings");
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]!.approver_session_id).toBe(approver.id);
    expect(JSON.stringify(pending.rows)).not.toContain(redemption.code);
  });

  it("works exactly once", async () => {
    const made = await createPairingToken(deps(), await laptop());
    if (!made.ok) throw new Error("expected a token");

    const results = await Promise.all([
      redeemPairingToken(deps(), made.token, "phone a"),
      redeemPairingToken(deps(), made.token, "phone b"),
    ]);
    const again = await redeemPairingToken(deps(), made.token, "phone c");

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(again).toEqual({ ok: false });
  });

  it("works for two minutes and not a moment longer", async () => {
    // Two laptops, since a new code cancels the same session's earlier ones.
    const early = await createPairingToken(deps(), await laptop());
    const late = await createPairingToken(deps(), await laptop());
    if (!early.ok || !late.ok) throw new Error("expected tokens");

    clock.advance(2 * MINUTE - 1);
    expect((await redeemPairingToken(deps(), early.token, "phone")).ok).toBe(true);
    clock.advance(1);
    expect(await redeemPairingToken(deps(), late.token, "phone")).toEqual({ ok: false });
  });

  it("stops working once the session that made it has gone", async () => {
    const approver = await laptop();
    const made = await createPairingToken(deps(), approver);
    if (!made.ok) throw new Error("expected a token");
    await db.query("delete from {{schema}}.sessions where id = $1", [approver.id]);

    expect(await redeemPairingToken(deps(), made.token, "phone")).toEqual({ ok: false });
  });

  it("stops working once the session that made it has expired", async () => {
    const approver = await laptop();
    clock.advance(30 * 24 * 60 * MINUTE - MINUTE);
    const signedInAgain = { ...approver, googleAuthAt: clock.now() };
    const made = await createPairingToken(deps(), signedInAgain);
    if (!made.ok) throw new Error("expected a token");
    clock.advance(MINUTE);

    expect(await redeemPairingToken(deps(), made.token, "phone")).toEqual({ ok: false });
  });

  it("gives every failure the same answer, revealing nothing about which check failed", async () => {
    const results = await Promise.all([
      redeemPairingToken(deps(), "not-a-token", "phone"),
      redeemPairingToken(deps(), "", "phone"),
    ]);

    expect(results).toEqual([{ ok: false }, { ok: false }]);
  });
});

describe("approvePairing", () => {
  it("approves the phone when the session that made the token types the matching code", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();

    expect(await approvePairing(deps(), approver, pairingId, code)).toEqual({ ok: true });
    expect(await findSession(deps(), phoneToken)).toMatchObject({ ok: true });
    expect((await db.query("select * from {{schema}}.pending_pairings")).rows).toEqual([]);
  });

  it("accepts the code typed with spaces", async () => {
    const { approver, pairingId, code } = await redeemed();

    expect(
      await approvePairing(deps(), approver, pairingId, `${code.slice(0, 3)} ${code.slice(3)}`),
    ).toEqual({ ok: true });
  });

  it("counts wrong codes, and deletes the phone's session at the fifth", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();

    for (let left = 4; left >= 1; left--) {
      expect(await approvePairing(deps(), approver, pairingId, wrong(code))).toEqual({
        ok: false,
        reason: "wrong-code",
        attemptsLeft: left,
      });
    }
    expect(await approvePairing(deps(), approver, pairingId, wrong(code))).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "missing" });
    expect(await approvePairing(deps(), approver, pairingId, code)).toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it("still accepts the right code on the fifth and last try", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();
    for (let i = 0; i < 4; i++) await approvePairing(deps(), approver, pairingId, wrong(code));

    expect(await approvePairing(deps(), approver, pairingId, code)).toEqual({ ok: true });
    expect(await findSession(deps(), phoneToken)).toMatchObject({ ok: true });
  });

  it("lets no other session approve, and counts nothing against the real one", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();
    const otherLaptop = await laptop();

    expect(await approvePairing(deps(), otherLaptop, pairingId, code)).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "unapproved" });
    expect(await approvePairing(deps(), approver, pairingId, code)).toEqual({ ok: true });
  });

  it("needs the approver's Google sign-in within five minutes, without spending an attempt", async () => {
    const { approver, pairingId, code } = await redeemed();
    clock.advance(5 * MINUTE + 1);

    expect(await approvePairing(deps(), approver, pairingId, wrong(code))).toEqual({
      ok: false,
      reason: "stale-google-auth",
    });
    const { rows } = await db.query<{ attempts: number }>(
      "select attempts from {{schema}}.pending_pairings",
    );
    expect(rows.map((r) => r.attempts)).toEqual([0]);
  });

  it("refuses a paired session as the approver", async () => {
    const { pairingId, code } = await redeemed();
    const phone = (await issueSession(deps(), { kind: "paired", label: "phone" })).session;

    expect(await approvePairing(deps(), phone, pairingId, code)).toEqual({
      ok: false,
      reason: "wrong-kind",
    });
  });

  it("is too late five minutes after the phone redeemed the token", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();
    clock.advance(5 * MINUTE);
    // The owner signs in again to approve, but the phone's time is up.
    const fresh = { ...approver, googleAuthAt: clock.now() };

    expect(await approvePairing(deps(), fresh, pairingId, code)).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("rejectPairing", () => {
  it("deletes the waiting phone's session", async () => {
    const { approver, phoneToken, pairingId } = await redeemed();

    expect(await rejectPairing(deps(), approver, pairingId)).toBe(true);
    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a paired session as the rejecter", async () => {
    const { phoneToken, pairingId } = await redeemed();
    const phone = (await issueSession(deps(), { kind: "paired", label: "phone" })).session;

    expect(await rejectPairing(deps(), phone, pairingId)).toBe(false);
    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "unapproved" });
  });

  it("lets no other session reject", async () => {
    const { phoneToken, pairingId } = await redeemed();

    expect(await rejectPairing(deps(), await laptop(), pairingId)).toBe(false);
    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "unapproved" });
  });
});

describe("waitingPhones", () => {
  it("shows the approver the phones waiting for it, and only those", async () => {
    const { approver, pairingId } = await redeemed();

    expect(await waitingPhones(deps(), approver)).toEqual([
      { pairingId, label: "Android · Chrome", redeemedAt: clock.now() },
    ]);
    expect(await waitingPhones(deps(), await laptop())).toEqual([]);
  });

  it("drops phones that waited five minutes", async () => {
    const { approver } = await redeemed();
    clock.advance(5 * MINUTE);

    expect(await waitingPhones(deps(), approver)).toEqual([]);
    expect(
      (await db.query("select * from {{schema}}.sessions where kind = 'paired'")).rows,
    ).toEqual([]);
  });
});

describe("pairingStatus", () => {
  it("follows the phone from waiting to approved", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();

    expect(await pairingStatus(deps(), phoneToken)).toBe("waiting");
    await approvePairing(deps(), approver, pairingId, code);
    expect(await pairingStatus(deps(), phoneToken)).toBe("approved");
  });

  it("says gone after Reject, after five minutes, and for a token it does not know", async () => {
    const rejected = await redeemed();
    await rejectPairing(deps(), rejected.approver, rejected.pairingId);
    const timedOut = await redeemed();
    clock.advance(5 * MINUTE);

    expect(await pairingStatus(deps(), rejected.phoneToken)).toBe("gone");
    expect(await pairingStatus(deps(), timedOut.phoneToken)).toBe("gone");
    expect(await pairingStatus(deps(), undefined)).toBe("gone");
  });

  it("goes on saying approved however long the phone has been paired", async () => {
    const { approver, phoneToken, pairingId, code } = await redeemed();
    await approvePairing(deps(), approver, pairingId, code);
    clock.advance(60 * MINUTE);

    expect(await pairingStatus(deps(), phoneToken)).toBe("approved");
  });
});

describe("expirePendingPairings", () => {
  it("deletes only phones still unapproved five minutes after redeeming", async () => {
    const approved = await redeemed();
    await approvePairing(deps(), approved.approver, approved.pairingId, approved.code);
    clock.advance(MINUTE);
    const waiting = await redeemed();
    clock.advance(4 * MINUTE);

    expect(await expirePendingPairings(db, clock.now())).toBe(0);
    clock.advance(MINUTE);
    expect(await expirePendingPairings(db, clock.now())).toBe(1);
    expect(await findSession(deps(), approved.phoneToken)).toMatchObject({ ok: true });
    expect(await findSession(deps(), waiting.phoneToken)).toEqual({ ok: false, reason: "missing" });
  });

  it("leaves a phone no one can approve any more to time out like the rest", async () => {
    const { approver, phoneToken } = await redeemed();
    await db.query("delete from {{schema}}.sessions where id = $1", [approver.id]);
    clock.advance(5 * MINUTE);

    await expirePendingPairings(db, clock.now());

    expect(await findSession(deps(), phoneToken)).toEqual({ ok: false, reason: "missing" });
  });
});
