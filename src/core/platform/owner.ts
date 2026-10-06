import type { Clock, Db } from "@/core/ports";

import type { GoogleIdentity } from "./googleIdentity";

export type { GoogleIdentity };

export type AdmissionRefusal =
  "no-owner-email" | "unverified-email" | "wrong-email" | "wrong-account";

/**
 * Owner pinning (platform spec B2): only a verified email equal to
 * OWNER_EMAIL gets in. The first such sign-in pins Google's `sub`, and every
 * later one must present it, so an address that changes hands later cannot
 * take over. An empty OWNER_EMAIL admits nobody.
 */
export async function admitOwner(
  deps: { db: Db; clock: Clock },
  identity: GoogleIdentity,
  ownerEmail: string,
): Promise<{ ok: true } | { ok: false; reason: AdmissionRefusal }> {
  const expected = ownerEmail.trim().toLowerCase();
  if (!expected) return { ok: false, reason: "no-owner-email" };
  if (!identity.emailVerified) return { ok: false, reason: "unverified-email" };
  if (identity.email.trim().toLowerCase() !== expected) return { ok: false, reason: "wrong-email" };

  // One statement pins the sub or returns the one already pinned, so two
  // first sign-ins racing each other cannot both win.
  const { rows } = await deps.db.query<{ google_sub: string }>(
    `insert into {{schema}}.owner as o (id, google_sub, pinned_at) values (1, $1, $2)
     on conflict (id) do update set google_sub = o.google_sub
     returning google_sub`,
    [identity.sub, deps.clock.now()],
  );
  return rows[0]?.google_sub === identity.sub
    ? { ok: true }
    : { ok: false, reason: "wrong-account" };
}
