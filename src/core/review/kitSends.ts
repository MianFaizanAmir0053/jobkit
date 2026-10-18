import type { Db } from "@/core/ports";

/**
 * The record of each "Approve & send" (decisions A20), kept in kit_sends:
 * the kit and the address it was pressed on, when it is due, and how it
 * went: sent, failed, cancelled by Undo, or unknown, when Gmail may have
 * taken it. A send counting down or sending holds the kit, so nothing else
 * sends it meanwhile. One a stopped server left behind holds it no longer,
 * and reads as it then stands: one never sent lapsed, and one left sending
 * may have gone.
 */

/** How long the owner has to press Undo. */
export const UNDO_MS = 10_000;
/** A send not delivered this long after it was due lapses: jobkit never sends late. */
export const LATE_MS = 2 * 60_000;
/**
 * A send still sending this long after it began was lost by a server that
 * stopped. Every step of a delivery has its own limit, and none reaches
 * Gmail later than BEGIN_WITHIN_MS after it began, so Gmail is done with it
 * well within this.
 */
export const STUCK_MS = 2 * 60_000;
/** A delivery that has not reached Gmail this long after it began never does. */
export const BEGIN_WITHIN_MS = 60_000;

/** What the owner reads about a send nothing delivered in time. */
export const LAPSED =
  "Not sent: jobkit was not running when it was due, and it never sends late. Press Approve & send again.";
/** What the owner reads about a send a stopped server left sending. */
export const LOST =
  "jobkit lost track of this send while Gmail had it, so it may have gone. Check your Gmail Sent folder: if it went, use Mark sent; if not, press Approve & send again.";

export type SendStatus = "scheduled" | "cancelled" | "sending" | "sent" | "failed" | "unknown";

export interface KitSend {
  id: string;
  /** The kit it was pressed on. */
  kit: string;
  status: SendStatus;
  to: string;
  sendAt: Date;
  messageId: string | null;
  /** Why it was not sent, or may not have been, in the owner's words. */
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
 * A send as the owner should read it now: one a stopped server left behind
 * reads as lapsed, or, left sending, as unknown, before anything settles
 * its row.
 */
export function asShown(send: KitSend, now: Date): KitSend {
  if (isLive(send, now)) return send;
  if (send.status === "scheduled") return { ...send, status: "failed", error: LAPSED };
  if (send.status === "sending") return { ...send, status: "unknown", error: LOST };
  return send;
}

/**
 * Whether the job page shows a send beside the kit it shows: one in flight,
 * sent or that may have gone, whatever kit it was pressed on; else only one
 * pressed on this kit, as an earlier kit's undone or failed send says
 * nothing about this one. The page and the send's route answer alike.
 */
export function showsFor(send: KitSend, kitKey: string): boolean {
  return (
    send.kit === kitKey ||
    send.status === "scheduled" ||
    send.status === "sending" ||
    send.status === "sent" ||
    send.status === "unknown"
  );
}

/** Whether jobkit sent the role's email: a send Gmail took holds the kit as sent, whatever came after. */
export async function anySent(db: Db, jobId: string, roleId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from {{schema}}.kit_sends
      where job_id = $1 and role_id = $2 and status = 'sent'
      limit 1`,
    [jobId, roleId],
  );
  return rows.length > 0;
}

/**
 * The role's latest send that may have gone, as it now stands, whatever came
 * after it: the page keeps warning about it until the kit is sent.
 */
/**
 * The condition, on a kit_sends row, of a send that may have gone: one that
 * says so, or one left sending past STUCK_MS before the time `stuckBefore`
 * names, which is now less STUCK_MS.
 */
export const uncertainWhere = (stuckBefore: string) =>
  `(status = 'unknown' or (status = 'sending' and updated_at < ${stuckBefore}))`;

export async function uncertainSend(
  db: Db,
  jobId: string,
  roleId: string,
  now: Date,
): Promise<KitSend | null> {
  const { rows } = await db.query<SendRow>(
    `select ${SEND_COLUMNS} from {{schema}}.kit_sends
      where job_id = $1 and role_id = $2 and ${uncertainWhere("$3")}
      order by created_at desc
      limit 1`,
    [jobId, roleId, new Date(now.getTime() - STUCK_MS)],
  );
  return rows[0] ? asShown(sendOf(rows[0]), now) : null;
}

/**
 * The send the job page shows for a role: the one in flight, of which there
 * is at most one; else the one Gmail took; else the latest.
 */
export async function latestSend(db: Db, jobId: string, roleId: string): Promise<KitSend | null> {
  const { rows } = await db.query<SendRow>(
    `select ${SEND_COLUMNS} from {{schema}}.kit_sends where job_id = $1 and role_id = $2
      order by case when status in ('scheduled', 'sending') then 0
                    when status = 'sent' then 1
                    else 2 end,
               created_at desc
      limit 1`,
    [jobId, roleId],
  );
  return rows[0] ? sendOf(rows[0]) : null;
}
