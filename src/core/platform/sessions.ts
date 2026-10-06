import type { Clock, Db, Random } from "@/core/ports";
import { base64url, sha256Hex } from "@/lib/encoding";

import { claimOne } from "./claim";

/**
 * Sessions (platform spec B2): a row plus a cookie holding a random token.
 * The row keeps only the token's hash, so a database leak hands out no
 * sessions. Lifetimes are absolute, set once when the row is made: renewing
 * a Google sign-in rotates the token but never moves the end date.
 */
export type SessionKind = "google" | "paired";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const SESSION_LIFETIME_MS: Readonly<Record<SessionKind, number>> = {
  google: 30 * DAY_MS,
  paired: 180 * DAY_MS,
};

/** `last_seen_at` moves at most this often, so page loads rarely write. */
const LAST_SEEN_STEP_MS = 60 * MINUTE_MS;

export interface Session {
  id: string;
  kind: SessionKind;
  label: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  googleAuthAt: Date | null;
}

/** The token goes into the cookie once and is never stored. */
export interface IssuedSession {
  session: Session;
  token: string;
}

export type SessionRefusal =
  "missing" | "expired" | "unapproved" | "wrong-kind" | "stale-google-auth";

export type SessionCheck = { ok: true; session: Session } | { ok: false; reason: SessionRefusal };

export interface SessionRequirements {
  kind?: SessionKind;
  /** Pairing and approval need a Google sign-in at most this old (B3: five minutes). */
  googleAuthWithinMs?: number;
}

export interface SessionDeps {
  db: Db;
  clock: Clock;
  random: Random;
}

type SessionRow = {
  id: string;
  kind: SessionKind;
  label: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  google_auth_at: Date | null;
};

const COLUMNS =
  "id, kind, label, created_at, last_seen_at, expires_at, approved_at, google_auth_at";

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    googleAuthAt: row.google_auth_at,
  };
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

function newToken(random: Random): { token: string; hash: string } {
  const token = base64url(random.bytes(32));
  return { token, hash: hashToken(token) };
}

/**
 * A Google sign-in approves its own session. A paired phone's session waits
 * for the owner to type its confirmation code on the laptop (B3); pass the
 * pairing transaction as `db` so both land together.
 */
export async function issueSession(
  deps: SessionDeps,
  opts: { kind: SessionKind; label: string },
): Promise<IssuedSession> {
  const now = deps.clock.now();
  const { token, hash } = newToken(deps.random);
  const signedIn = opts.kind === "google" ? now : null;
  const { rows } = await deps.db.query<SessionRow>(
    `insert into {{schema}}.sessions
       (token_hash, kind, label, created_at, last_seen_at, expires_at, approved_at, google_auth_at)
     values ($1, $2, $3, $4, $4, $5, $6, $6)
     returning ${COLUMNS}`,
    [
      hash,
      opts.kind,
      opts.label,
      now,
      new Date(now.getTime() + SESSION_LIFETIME_MS[opts.kind]),
      signedIn,
    ],
  );
  return { session: toSession(rows[0]!), token };
}

/** The per-request lookup behind `requireSession`: a live, approved session or the reason not. */
export async function findSession(
  deps: Pick<SessionDeps, "db" | "clock">,
  token: string | undefined,
): Promise<SessionCheck> {
  if (!token) return { ok: false, reason: "missing" };
  const { rows } = await deps.db.query<SessionRow>(
    `select ${COLUMNS} from {{schema}}.sessions where token_hash = $1`,
    [hashToken(token)],
  );
  if (!rows[0]) return { ok: false, reason: "missing" };
  const session = toSession(rows[0]);
  const now = deps.clock.now();
  if (now.getTime() >= session.expiresAt.getTime()) return { ok: false, reason: "expired" };
  if (!session.approvedAt) return { ok: false, reason: "unapproved" };

  if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_STEP_MS) {
    await deps.db.query("update {{schema}}.sessions set last_seen_at = $2 where id = $1", [
      session.id,
      now,
    ]);
    session.lastSeenAt = now;
  }
  return { ok: true, session };
}

/** What a page or action asks of the session it found, beyond being live. */
export function checkRequirements(
  session: Session,
  now: Date,
  require: SessionRequirements,
): SessionCheck {
  if (require.kind && session.kind !== require.kind) return { ok: false, reason: "wrong-kind" };
  if (require.googleAuthWithinMs !== undefined) {
    const signedIn = session.googleAuthAt?.getTime();
    if (signedIn === undefined || now.getTime() - signedIn > require.googleAuthWithinMs) {
      return { ok: false, reason: "stale-google-auth" };
    }
  }
  return { ok: true, session };
}

/**
 * A fresh Google sign-in inside a live `google` session (B2): the same row
 * gets a new `google_auth_at` and a new token, so the old token stops working.
 * Returns null when the session has ended or is not a `google` one.
 */
export async function reauthenticate(
  deps: SessionDeps,
  sessionId: string,
): Promise<IssuedSession | null> {
  const now = deps.clock.now();
  const { token, hash } = newToken(deps.random);
  const row = await claimOne<SessionRow>(
    deps.db,
    `update {{schema}}.sessions
        set token_hash = $2, google_auth_at = $3, last_seen_at = $3
      where id = $1 and kind = 'google' and expires_at > $3
      returning ${COLUMNS}`,
    [sessionId, hash, now],
  );
  return row ? { session: toSession(row), token } : null;
}

/** Sign out: deletes the row the token belongs to. */
export async function endSession(db: Db, token: string): Promise<void> {
  await db.query("delete from {{schema}}.sessions where token_hash = $1", [hashToken(token)]);
}

/** The cookie's Max-Age: whole seconds left until the session's absolute end. */
export function remainingSeconds(session: Session, now: Date): number {
  return Math.max(0, Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000));
}

/** The name the Devices page shows for a session, such as "Windows · Chrome". */
export function deviceLabel(agent: { os: { name?: string }; browser: { name?: string } }): string {
  return `${agent.os.name ?? "Unknown system"} · ${agent.browser.name ?? "unknown browser"}`;
}
