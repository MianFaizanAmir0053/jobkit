import type { Db } from "@/core/ports";

/**
 * The record of each "Approve & send" (decisions A20), kept in kit_sends:
 * the kit and the address it was pressed on, when it is due, and how it
 * went. A send counting down or sending holds the kit, so nothing else
 * sends it meanwhile; one a stopped server left behind does not hold it for
 * ever.
 */

/** How long the owner has to press Undo. */
export const UNDO_MS = 10_000;
/** A send not delivered this long after it was due lapses: jobkit never sends late. */
export const LATE_MS = 2 * 60_000;
/** A send still sending this long after it began was lost by a server that stopped. */
export const STUCK_MS = 2 * 60_000;

export type SendStatus = "scheduled" | "cancelled" | "sending" | "sent" | "failed";

export interface KitSend {
  id: string;
  /** The kit it was pressed on. */
  kit: string;
  status: SendStatus;
  to: string;
  sendAt: Date;
  messageId: string | null;
  /** Why it was not sent, in the owner's words. */
  error: string | null;
  updatedAt: Date;
}

export type SendRow = {
  id: string;
  role_id: string;
  kit: string;
  status: SendStatus;
  to_address: string;
  send_at: Date;
  gmail_message_id: string | null;
  error: string | null;
  session_id: string | null;
  updated_at: Date;
};

export const SEND_COLUMNS =
  "id, role_id, kit, status, to_address, send_at, gmail_message_id, error, session_id, updated_at";

export function sendOf(row: SendRow): KitSend {
  return {
    id: row.id,
    kit: row.kit,
    status: row.status,
    to: row.to_address,
    sendAt: row.send_at,
    messageId: row.gmail_message_id,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

/** Whether a send holds its kit: counting down or sending, and not left behind by a stopped server. */
export function isLive(send: Pick<KitSend, "status" | "sendAt" | "updatedAt">, now: Date): boolean {
  switch (send.status) {
    case "scheduled":
      return now.getTime() <= send.sendAt.getTime() + LATE_MS;
    case "sending":
      return now.getTime() <= send.updatedAt.getTime() + STUCK_MS;
    default:
      return false;
  }
}

/**
 * The send the job page shows for a role: the one counting down, sending or
 * sent, of which there is at most one; else the latest.
 */
export async function latestSend(db: Db, jobId: string, roleId: string): Promise<KitSend | null> {
  const { rows } = await db.query<SendRow>(
    `select ${SEND_COLUMNS} from {{schema}}.kit_sends where job_id = $1 and role_id = $2
      order by (status in ('scheduled', 'sending', 'sent')) desc, created_at desc
      limit 1`,
    [jobId, roleId],
  );
  return rows[0] ? sendOf(rows[0]) : null;
}
