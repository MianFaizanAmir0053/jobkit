import type { Clock, Db } from "@/core/ports";

import { claimOne } from "./claim";
import { checkRequirements, type Session, type SessionKind } from "./sessions";

/** The Devices page (platform spec B2, B3): the sessions that can use the app now. */
export interface Device {
  id: string;
  kind: SessionKind;
  label: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  current: boolean;
}

/** Live, approved sessions: the viewer's own first, then the most recently seen. */
export async function listDevices(
  deps: { db: Db; clock: Clock },
  viewer: Session,
): Promise<Device[]> {
  const { rows } = await deps.db.query<{
    id: string;
    kind: SessionKind;
    label: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
  }>(
    `select id, kind, label, created_at, last_seen_at, expires_at
       from {{schema}}.sessions
      where approved_at is not null and expires_at > $2
      order by id = $1 desc, last_seen_at desc, created_at desc`,
    [viewer.id, deps.clock.now()],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    current: r.id === viewer.id,
  }));
}

/**
 * Revoke deletes another session's row, so its next request is refused.
 * Only google sessions may; a session ends itself by signing out.
 */
export async function revokeSession(
  deps: { db: Db; clock: Clock },
  actor: Session,
  targetId: string,
): Promise<boolean> {
  if (!checkRequirements(actor, deps.clock.now(), { kind: "google" }).ok) return false;
  if (targetId === actor.id) return false;
  const deleted = await claimOne(
    deps.db,
    "delete from {{schema}}.sessions where id = $1 returning id",
    [targetId],
  );
  return deleted !== null;
}
