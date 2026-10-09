import type { Db } from "@/core/ports";
import { base64url, sha256Hex } from "@/lib/encoding";

import { claimOne } from "./claim";
import {
  checkRequirements,
  hashToken,
  issueSession,
  type IssuedSession,
  type Session,
  type SessionDeps,
} from "./sessions";

/**
 * QR pairing (platform spec B3). The laptop's google session makes a token
 * that works once, for two minutes; the phone that redeems it gets a paired
 * session that waits until the same laptop session types the six-digit code
 * the phone shows. Someone who redeems a leaked QR code first still needs
 * the owner to type the code only their screen shows.
 */
const MINUTE_MS = 60_000;
export const PAIRING_TOKEN_LIFETIME_MS = 2 * MINUTE_MS;
/** How long a redeemed phone waits, and how recent the approver's Google sign-in must be. */
export const PAIRING_WINDOW_MS = 5 * MINUTE_MS;
const MAX_CODE_ATTEMPTS = 5;

const PAIRING_REQUIREMENTS = { kind: "google", googleAuthWithinMs: PAIRING_WINDOW_MS } as const;

export type PairingRefusal = "wrong-kind" | "stale-google-auth";

export async function createPairingToken(
  deps: SessionDeps,
  creator: Session,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; reason: PairingRefusal }> {
  const now = deps.clock.now();
  const allowed = checkRequirements(creator, now, PAIRING_REQUIREMENTS);
  if (!allowed.ok) return { ok: false, reason: allowed.reason as PairingRefusal };
  const token = base64url(deps.random.bytes(32));
  const expiresAt = new Date(now.getTime() + PAIRING_TOKEN_LIFETIME_MS);
  await deps.db.tx(async (tx) => {
    // The session's own row first: two codes made at the same moment then
    // queue, and the second one's delete sees, and cancels, the first.
    await tx.query("select id from {{schema}}.sessions where id = $1 for no key update", [
      creator.id,
    ]);
    // A new code cancels the session's earlier unused ones, so a QR code
    // caught in an older screenshot stops working as soon as the owner moves on.
    await tx.query(
      "delete from {{schema}}.pairing_tokens where created_by = $1 and used_at is null",
      [creator.id],
    );
    await tx.query(
      `insert into {{schema}}.pairing_tokens (token_hash, created_by, created_at, expires_at)
       values ($1, $2, $3, $4)`,
      [hashToken(token), creator.id, now, expiresAt],
    );
  });
  return { ok: true, token, expiresAt };
}

/** Every failure looks the same, so a guesser learns nothing about which check failed. */
export type Redemption = { ok: true; issued: IssuedSession; code: string } | { ok: false };

/**
 * `replacing` is a session token the redeeming browser already holds (a
 * phone pairing again): it is deleted in the same transaction, so a failed
 * redemption keeps it and a successful one never leaves both behind.
 */
export async function redeemPairingToken(
  deps: SessionDeps,
  token: string,
  label: string,
  replacing?: string,
): Promise<Redemption> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    // Lock the creating session's row before the token's: signing out or
    // revoking that session locks it first too, then deletes its tokens, so
    // the two wait for each other instead of deadlocking.
    await tx.query(
      `select s.id from {{schema}}.sessions s
         join {{schema}}.pairing_tokens t on t.created_by = s.id
        where t.token_hash = $1
          for key share of s`,
      [hashToken(token)],
    );
    const claimed = await claimOne<{ created_by: string }>(
      tx,
      `update {{schema}}.pairing_tokens t
          set used_at = $2
        where t.token_hash = $1 and t.used_at is null and t.expires_at > $2
          and exists (
            select 1 from {{schema}}.sessions s
             where s.id = t.created_by and s.kind = 'google' and s.expires_at > $2
          )
        returning t.created_by`,
      [hashToken(token), now],
    );
    if (!claimed) return { ok: false };
    if (replacing) {
      await tx.query("delete from {{schema}}.sessions where token_hash = $1", [
        hashToken(replacing),
      ]);
    }
    const issued = await issueSession({ ...deps, db: tx }, { kind: "paired", label });
    const code = sixDigitCode(deps.random);
    await tx.query(
      `insert into {{schema}}.pending_pairings
         (session_id, approver_session_id, code_hash, created_at)
       values ($1, $2, $3, $4)`,
      [issued.session.id, claimed.created_by, hashCode(issued.session.id, code), now],
    );
    return { ok: true, issued, code };
  });
}

export type Approval =
  | { ok: true }
  | { ok: false; reason: "wrong-code"; attemptsLeft: number }
  | { ok: false; reason: "gone" | PairingRefusal };

/**
 * Only the session that made the token approves, with the phone's code, and
 * only while its own Google sign-in is recent. Each try, right or wrong,
 * spends one of five; the fifth wrong code deletes the phone's session, and
 * so does the end of its five minutes.
 */
export async function approvePairing(
  deps: SessionDeps,
  approver: Session,
  pairingId: string,
  typedCode: string,
): Promise<Approval> {
  const now = deps.clock.now();
  const allowed = checkRequirements(approver, now, PAIRING_REQUIREMENTS);
  if (!allowed.ok) return { ok: false, reason: allowed.reason as PairingRefusal };
  const code = typedCode.replace(/\s+/g, "");
  const cutoff = new Date(now.getTime() - PAIRING_WINDOW_MS);

  return deps.db.tx(async (tx): Promise<Approval> => {
    // The phone's row first, the order Reject, Revoke and the timeout take.
    await tx.query("select id from {{schema}}.sessions where id = $1 for no key update", [
      pairingId,
    ]);
    // One conditional update spends a try and tests the code, so concurrent
    // guesses queue on the row and cannot share a count.
    const tried = await claimOne<{ attempts: number; matched: boolean }>(
      tx,
      `update {{schema}}.pending_pairings set attempts = attempts + 1
        where session_id = $1 and approver_session_id = $2 and created_at > $3
          and attempts < $4
        returning attempts, code_hash = $5 as matched`,
      [pairingId, approver.id, cutoff, MAX_CODE_ATTEMPTS, hashCode(pairingId, code)],
    );
    if (!tried) {
      // Its five minutes may be up: delete this phone, under the lock already
      // held. Sweeping the other phones too would take their locks and could
      // deadlock with their own status polls.
      await tx.query(
        `delete from {{schema}}.sessions
          where id = $1 and kind = 'paired' and approved_at is null and created_at <= $2`,
        [pairingId, cutoff],
      );
      return { ok: false, reason: "gone" };
    }
    if (tried.matched) {
      await tx.query("delete from {{schema}}.pending_pairings where session_id = $1", [pairingId]);
      await tx.query("update {{schema}}.sessions set approved_at = $2 where id = $1", [
        pairingId,
        now,
      ]);
      return { ok: true };
    }
    if (tried.attempts >= MAX_CODE_ATTEMPTS) {
      await deleteWaitingPhone(tx, pairingId);
      return { ok: false, reason: "gone" };
    }
    return { ok: false, reason: "wrong-code", attemptsLeft: MAX_CODE_ATTEMPTS - tried.attempts };
  });
}

/** Reject: deletes the waiting phone's session. Only its approver may. */
export async function rejectPairing(
  deps: SessionDeps,
  approver: Session,
  pairingId: string,
): Promise<boolean> {
  if (!checkRequirements(approver, deps.clock.now(), { kind: "google" }).ok) return false;
  const deleted = await claimOne(
    deps.db,
    `delete from {{schema}}.sessions s
      where s.id = $1 and s.approved_at is null
        and exists (
          select 1 from {{schema}}.pending_pairings p
           where p.session_id = s.id and p.approver_session_id = $2
        )
      returning s.id`,
    [pairingId, approver.id],
  );
  return deleted !== null;
}

export interface WaitingPhone {
  pairingId: string;
  label: string;
  redeemedAt: Date;
}

/** What the approver's Devices page shows as "A phone is waiting". */
export async function waitingPhones(deps: SessionDeps, approver: Session): Promise<WaitingPhone[]> {
  await expirePendingPairings(deps.db, deps.clock.now());
  const { rows } = await deps.db.query<{ session_id: string; label: string; created_at: Date }>(
    `select p.session_id, s.label, p.created_at
       from {{schema}}.pending_pairings p
       join {{schema}}.sessions s on s.id = p.session_id
      where p.approver_session_id = $1
      order by p.created_at`,
    [approver.id],
  );
  return rows.map((r) => ({ pairingId: r.session_id, label: r.label, redeemedAt: r.created_at }));
}

/** What the phone polls while it shows its code. */
export async function pairingStatus(
  deps: Pick<SessionDeps, "db" | "clock">,
  token: string | undefined,
): Promise<"waiting" | "approved" | "gone"> {
  if (!token) return "gone";
  const now = deps.clock.now();
  await expirePendingPairings(deps.db, now);
  const { rows } = await deps.db.query<{ approved_at: Date | null; expires_at: Date }>(
    "select approved_at, expires_at from {{schema}}.sessions where token_hash = $1",
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.expires_at.getTime() <= now.getTime()) return "gone";
  return row.approved_at ? "approved" : "waiting";
}

/**
 * Platform spec B9: timeouts apply when status is read (and by the daily
 * job as a backstop). A phone still unapproved five minutes after redeeming
 * is deleted, including one whose approver has gone.
 */
export async function expirePendingPairings(db: Db, now: Date): Promise<number> {
  const { rowCount } = await db.query(
    `delete from {{schema}}.sessions
      where kind = 'paired' and approved_at is null and created_at <= $1`,
    [new Date(now.getTime() - PAIRING_WINDOW_MS)],
  );
  return rowCount;
}

async function deleteWaitingPhone(db: Db, pairingId: string): Promise<void> {
  await db.query(
    "delete from {{schema}}.sessions where id = $1 and kind = 'paired' and approved_at is null",
    [pairingId],
  );
}

/** Six digits, every code equally likely: 32-bit draws past the last whole million are thrown back. */
function sixDigitCode(random: SessionDeps["random"]): string {
  for (;;) {
    const n = Buffer.from(random.bytes(4)).readUInt32BE(0);
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0");
  }
}

function hashCode(sessionId: string, code: string): string {
  return sha256Hex(`${sessionId}:${code}`);
}
