import type { Clock, Db } from "@/core/ports";

import { openSealed, seal } from "./seal";

/**
 * The owner's Gmail connection for one-click send (decisions A20): one row,
 * the account, the scopes Google granted and the refresh token sealed with
 * GMAIL_TOKEN_KEY. The token leaves this module only to the code that sends
 * or revokes, never to a page.
 */

export interface GmailConnection {
  email: string;
  scopes: string[];
  connectedAt: Date;
}

/** Keeps the connection, replacing any earlier one. */
export async function keepGmailConnection(
  deps: { db: Db; clock: Clock },
  key: Buffer,
  connection: { email: string; refreshToken: string; scopes: readonly string[] },
): Promise<void> {
  await deps.db.query(
    `insert into {{schema}}.gmail_connection (id, email, refresh_token_sealed, scopes, connected_at)
     values (1, $1, $2, $3, $4)
     on conflict (id) do update set email = excluded.email,
       refresh_token_sealed = excluded.refresh_token_sealed,
       scopes = excluded.scopes, connected_at = excluded.connected_at`,
    [
      connection.email,
      seal(connection.refreshToken, key),
      [...connection.scopes],
      deps.clock.now(),
    ],
  );
}

/** The connection as a page may show it, without its token; null when Gmail is not connected. */
export async function gmailConnection(db: Db): Promise<GmailConnection | null> {
  const { rows } = await db.query<{ email: string; scopes: string[]; connected_at: Date }>(
    "select email, scopes, connected_at from {{schema}}.gmail_connection where id = 1",
  );
  const row = rows[0];
  return row ? { email: row.email, scopes: row.scopes, connectedAt: row.connected_at } : null;
}

/** The refresh token, opened; null without a connection, or when the key cannot open it. */
export async function gmailRefreshToken(db: Db, key: Buffer): Promise<string | null> {
  const { rows } = await db.query<{ refresh_token_sealed: string }>(
    "select refresh_token_sealed from {{schema}}.gmail_connection where id = 1",
  );
  return openOrNull(rows[0]?.refresh_token_sealed, key);
}

/** Deletes the connection; gives its refresh token, opened, to revoke, or null when there was none. */
export async function dropGmailConnection(db: Db, key: Buffer): Promise<string | null> {
  const { rows } = await db.query<{ refresh_token_sealed: string }>(
    "delete from {{schema}}.gmail_connection where id = 1 returning refresh_token_sealed",
  );
  return openOrNull(rows[0]?.refresh_token_sealed, key);
}

function openOrNull(sealed: string | undefined, key: Buffer): string | null {
  if (sealed === undefined) return null;
  try {
    return openSealed(sealed, key);
  } catch {
    return null;
  }
}
