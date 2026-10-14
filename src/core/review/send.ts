import { emailBody } from "@/core/drafting/kit";
import { getProfileVersion } from "@/core/profile/profile";
import type { Clock, Db, GmailSender, GmailSendResult, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";
import { within } from "@/lib/within";

import { canHandOff } from "./canHandOff";
import { approveAll, gateInputOf, NO_DECISIONS } from "./decisions";
import type { JobView } from "./jobView";
import {
  type KitSend,
  LAPSED,
  LATE_MS,
  LOST,
  SEND_COLUMNS,
  sendOf,
  type SendRow,
  STUCK_MS,
  UNDO_MS,
} from "./kitSends";
import { keep, lockedKit } from "./kitReview";
import { keepGate, lockReview, markSentByJobkit } from "./markSent";
import { buildMime } from "./mime";

export { LATE_MS, STUCK_MS, UNDO_MS } from "./kitSends";

/**
 * "Approve & send" (decisions A20). The press, under the kit's review row's
 * lock, checks that the page showed the kit and the address that stand,
 * marks "I checked this" on every flagged sentence and flag, and schedules
 * the send ten seconds ahead, all or nothing: refused while a hard stop
 * holds the kit, for a post that asks for a file besides the CV, which
 * jobkit cannot attach, while another send of it is in flight, or once it
 * went. Undo stops it until it begins. Delivery claims it when due, under
 * the same locks, so two deliveries send once; checks again that the kit,
 * its address and its open gate are as pressed; then sends the email with
 * the profile's signature and CV from the owner's Gmail. What Gmail took is
 * kept as sent first, whatever happened meanwhile, then marked sent in the
 * ledger. A send that cannot go fails with the reason in the owner's words,
 * and the kit opens again; one Gmail may have taken is kept as unknown,
 * with word to check the Sent folder. jobkit never sends late, and every
 * step of a delivery has its own limit, so none outlives STUCK_MS.
 */

/** How long reading the CV may take; Gmail's own steps have theirs (src/adapters/gmail.ts). */
const CV_READ_MS = 15_000;

const NOT_SENT = {
  changed:
    "Not sent: the email changed after you pressed Send. Check it, then press Approve & send again.",
  alreadySent: "Not sent: this email was already sent.",
  notConnected:
    "Not sent: Gmail is not connected. Connect Gmail on the Devices page, then press Approve & send again.",
  refused:
    "Not sent: Google refused jobkit's access to your Gmail. Connect Gmail again on the Devices page, then press Approve & send again.",
  noProfile: "Not sent: the profile this email was written with is gone.",
  noCv: "Not sent: jobkit cannot find the CV this email was written with. Seed that profile again, or send it yourself with Open in Gmail.",
};

export type ScheduleOutcome =
  | { ok: true; send: KitSend }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-ready"
        | "changed"
        | "sent"
        | "not-email"
        | "sending"
        | "held"
        | "attachment";
    };

/** The kit and the address the page showed as the owner pressed Send, and their session. */
export interface Pressed {
  kit: string;
  to: string;
  sessionId: string | null;
}

export async function scheduleSend(
  deps: { db: Db; clock: Clock },
  jobId: string,
  pressed: Pressed,
): Promise<ScheduleOutcome> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx): Promise<ScheduleOutcome> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, { kit: pressed.kit });
    if (!("view" in locked)) return locked;
    const { view } = locked;
    const roleId = view.role!.id;
    if (view.role!.route.kind !== "email") return { ok: false, reason: "not-email" };
    if (view.kitParts.sending) return { ok: false, reason: "sending" };
    // jobkit attaches the CV alone: a post asking for another file goes through Gmail.
    if (view.kitParts.attachments.length > 0) return { ok: false, reason: "attachment" };
    const decisions = approveAll(view.kitParts, view.review?.decisions ?? NO_DECISIONS);
    if (canHandOff(gateInputOf(view.kitParts, decisions)).length > 0) {
      return { ok: false, reason: "held" };
    }
    const to = view.handoff?.to ?? "";
    if (to === "" || to !== pressed.to) return { ok: false, reason: "changed" };
    const now = deps.clock.now();
    await settleLeftBehind(tx, jobId, roleId, now);
    const { rows } = await tx.query<SendRow>(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, session_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'scheduled', $5, $6, $7, $7)
       returning ${SEND_COLUMNS}`,
      [jobId, roleId, view.kitKey, to, new Date(now.getTime() + UNDO_MS), pressed.sessionId, now],
    );
    await keep(at, jobId, roleId, view.kitKey, decisions);
    return { ok: true, send: sendOf(rows[0]!) };
  });
}

/**
 * Settles the role's sends a stopped server left behind, which hold the
 * kit no longer, as the page already shows them: one never claimed lapsed,
 * and one left sending may have gone. The one send in flight the table
 * allows can then be the new one.
 */
async function settleLeftBehind(db: Db, jobId: string, roleId: string, now: Date): Promise<void> {
  await db.query(
    `update {{schema}}.kit_sends
        set status = case when status = 'scheduled' then 'failed' else 'unknown' end,
            error = case when status = 'scheduled' then $6 else $7 end,
            updated_at = $3
      where job_id = $1 and role_id = $2
        and ((status = 'scheduled' and send_at < $4) or (status = 'sending' and updated_at < $5))`,
    [
      jobId,
      roleId,
      now,
      new Date(now.getTime() - LATE_MS),
      new Date(now.getTime() - STUCK_MS),
      LAPSED,
      LOST,
    ],
  );
}

/** Locks the send's row, after its kit's review row, as every change to a send does. */
async function lockedSend(db: Db, sendId: string): Promise<SendRow> {
  const { rows } = await db.query<SendRow>(
    `select ${SEND_COLUMNS} from {{schema}}.kit_sends where id = $1 for update`,
    [sendId],
  );
  return rows[0]!;
}

async function sendRow(db: Db, jobId: string, sendId: string): Promise<SendRow | null> {
  if (!isUuid(jobId) || !isUuid(sendId)) return null;
  const { rows } = await db.query<SendRow>(
    `select ${SEND_COLUMNS} from {{schema}}.kit_sends where id = $1 and job_id = $2`,
    [sendId, jobId],
  );
  return rows[0] ?? null;
}

/**
 * Undo: stops a send counting down. One that failed, or was undone, goes
 * nowhere already; one Gmail has, or may have, is too late to stop.
 */
export async function undoSend(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sendId: string,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "too-late" }> {
  const found = await sendRow(deps.db, jobId, sendId);
  if (!found) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { db: tx, clock: deps.clock };
    await lockReview(at, jobId, found.role_id);
    const row = await lockedSend(tx, sendId);
    if (row.status === "cancelled" || row.status === "failed") return { ok: true as const };
    if (row.status !== "scheduled") return { ok: false as const, reason: "too-late" as const };
    await tx.query(
      "update {{schema}}.kit_sends set status = 'cancelled', updated_at = $2 where id = $1",
      [sendId, deps.clock.now()],
    );
    await keepGate(at, jobId, found.role_id);
    return { ok: true as const };
  });
}

export interface DeliverDeps {
  db: Db;
  clock: Clock;
  storage: Storage;
  /** The owner's Gmail; null when it is not connected. */
  gmail: () => Promise<GmailSender | null>;
}

export type DeliverOutcome =
  /** The send as it now stands: sent, failed, unknown or cancelled, or sending in another delivery. */
  | { ok: true; send: KitSend }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-due"; send: KitSend };

type Claim =
  { claimed: false; outcome: DeliverOutcome } | { claimed: true; row: SendRow; view: JobView };

export async function deliverSend(
  deps: DeliverDeps,
  jobId: string,
  sendId: string,
): Promise<DeliverOutcome> {
  const found = await sendRow(deps.db, jobId, sendId);
  if (!found) return { ok: false, reason: "not-found" };
  const claim = await claimSend(deps, jobId, found);
  if (!claim.claimed) return claim.outcome;
  const { row, view } = claim;
  // Until Gmail has it, nothing went.
  let email: string | { problem: string };
  let gmail: GmailSender | null;
  try {
    email = await emailOf(deps, view, row.to_address);
    gmail = await deps.gmail();
  } catch (error) {
    return settle(deps, jobId, row, "failed", `Not sent: ${errorText(error)}`);
  }
  if (typeof email !== "string") return settle(deps, jobId, row, "failed", email.problem);
  if (!gmail) return settle(deps, jobId, row, "failed", NOT_SENT.notConnected);
  let result: GmailSendResult;
  try {
    result = await gmail.send(email);
  } catch (error) {
    result = { ok: false, reason: "unknown", message: errorText(error) };
  }
  if (result.ok) return sent(deps, jobId, row, result);
  return settle(
    deps,
    jobId,
    row,
    result.reason === "unknown" ? "unknown" : "failed",
    notSentWords(result),
  );
}

/**
 * Claims a send that is due, under its kit's review row's lock and its own:
 * one counting down still, or no longer counting down, is left as it is.
 * The kit, the address and the gate must stand as they did at the press;
 * a send that lapsed, or whose kit changed, fails without sending.
 */
async function claimSend(deps: DeliverDeps, jobId: string, found: SendRow): Promise<Claim> {
  return deps.db.tx(async (tx): Promise<Claim> => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, { kit: found.kit });
    const row = await lockedSend(tx, found.id);
    const now = deps.clock.now();
    const done = (outcome: DeliverOutcome): Claim => ({ claimed: false, outcome });
    if (row.status !== "scheduled") return done({ ok: true, send: sendOf(row) });
    if (now.getTime() < row.send_at.getTime()) {
      return done({ ok: false, reason: "not-due", send: sendOf(row) });
    }
    const fail = async (error: string) => {
      const failedSend = await settleRow(tx, row, "failed", now, error);
      await keepGate(at, jobId, row.role_id);
      return done({ ok: true, send: failedSend });
    };
    if (now.getTime() > row.send_at.getTime() + LATE_MS) return fail(LAPSED);
    if (!("view" in locked)) {
      return fail(locked.reason === "sent" ? NOT_SENT.alreadySent : NOT_SENT.changed);
    }
    const { view } = locked;
    if ((view.handoff?.to ?? "") !== row.to_address) return fail(NOT_SENT.changed);
    // This send holds the kit as sending: whatever else holds it stops it.
    const held = canHandOff({
      ...gateInputOf(view.kitParts, view.review?.decisions ?? NO_DECISIONS),
      sending: false,
    });
    if (held.length > 0) return fail(`Not sent: ${held[0]!.message}`);
    await tx.query(
      "update {{schema}}.kit_sends set status = 'sending', updated_at = $2 where id = $1",
      [row.id, now],
    );
    return { claimed: true, row: { ...row, status: "sending", updated_at: now }, view };
  });
}

/** Why Gmail did not send it, or may not have, in the owner's words, with what to do next. */
function notSentWords(result: Extract<GmailSendResult, { ok: false }>): string {
  switch (result.reason) {
    case "unauthorised":
      return NOT_SENT.refused;
    case "unknown":
      return `jobkit cannot tell whether Gmail sent this email (${result.message}). Check your Gmail Sent folder: if it went, use Mark sent; if not, press Approve & send again.`;
    case "failed":
      return `Not sent: Gmail could not send it (${result.message}). Press Approve & send to try again.`;
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The email as Gmail sends it: the kit's subject and body, the profile's
 * signature under the closing, as Gmail adds none to an email sent this
 * way, and the CV of the profile the email was written with.
 */
async function emailOf(
  deps: DeliverDeps,
  view: JobView,
  to: string,
): Promise<string | { problem: string }> {
  const draft = view.draft!;
  const profile = await getProfileVersion(deps.db, draft.profileVersion);
  if (!profile) return { problem: NOT_SENT.noProfile };
  const cv = await within(deps.storage.get(profile.cv.path), CV_READ_MS, "Reading your CV");
  if (!cv) return { problem: NOT_SENT.noCv };
  const body = [emailBody(draft.kit), profile.signature.trim()].filter(Boolean).join("\n");
  return buildMime({
    to,
    subject: draft.kit.subject,
    body,
    attachment: {
      filename: cvFileName(profile.owner.name),
      contentType: "application/pdf",
      bytes: cv,
    },
  });
}

/** The CV's file name as the recruiter sees it: the owner's name, in plain letters. */
export function cvFileName(name: string): string {
  const plain = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 .-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return plain === "" ? "CV.pdf" : `${plain} CV.pdf`;
}

async function settleRow(
  db: Db,
  row: SendRow,
  status: "failed" | "unknown",
  now: Date,
  error: string,
): Promise<KitSend> {
  const { rows } = await db.query<SendRow>(
    `update {{schema}}.kit_sends set status = $2, error = $3, updated_at = $4
      where id = $1 returning ${SEND_COLUMNS}`,
    [row.id, status, error, now],
  );
  return sendOf(rows[0]!);
}

/**
 * A send that did not go, or may have: failed or unknown, with why, and the
 * kit's gate kept as it now stands.
 */
async function settle(
  deps: DeliverDeps,
  jobId: string,
  row: SendRow,
  status: "failed" | "unknown",
  error: string,
): Promise<DeliverOutcome> {
  return deps.db.tx(async (tx) => {
    const at = { db: tx, clock: deps.clock };
    await lockReview(at, jobId, row.role_id);
    const send = await settleRow(tx, row, status, deps.clock.now(), error);
    await keepGate(at, jobId, row.role_id);
    return { ok: true as const, send };
  });
}

/**
 * A send Gmail took. That it went is kept first, on its own, whatever
 * happened meanwhile, as a press made after the send looked stuck; then the
 * application is marked sent, by the session that pressed it while that
 * session lasts. A ledger that cannot take it leaves the send sent, with
 * why.
 */
async function sent(
  deps: DeliverDeps,
  jobId: string,
  row: SendRow,
  result: Extract<GmailSendResult, { ok: true }>,
): Promise<DeliverOutcome> {
  await deps.db.query(
    `update {{schema}}.kit_sends
        set status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, error = null,
            updated_at = $4
      where id = $1`,
    [row.id, result.messageId, result.threadId || null, deps.clock.now()],
  );
  const unrecorded = (why: string) =>
    `Sent from your Gmail, but jobkit could not record it in your applications (${why}).`;
  try {
    await deps.db.tx(async (tx) => {
      const at = { db: tx, clock: deps.clock };
      await lockReview(at, jobId, row.role_id);
      // The session that pressed it, kept from being deleted until this ends; none once signed out.
      const { rows: sessions } = await tx.query<{ id: string }>(
        `select s.id from {{schema}}.kit_sends as k
           join {{schema}}.sessions as s on s.id = k.session_id
          where k.id = $1
          for key share of s`,
        [row.id],
      );
      const marked = await markSentByJobkit(at, jobId, sessions[0]?.id ?? null, row.to_address);
      if (!marked.ok) {
        await tx.query("update {{schema}}.kit_sends set error = $2 where id = $1", [
          row.id,
          unrecorded(marked.reason),
        ]);
      }
    });
  } catch (error) {
    await deps.db
      .query("update {{schema}}.kit_sends set error = $2 where id = $1", [
        row.id,
        unrecorded(errorText(error)),
      ])
      .catch(() => {
        // The send stays sent; only the reason the ledger missed it is lost.
      });
  }
  const { rows } = await deps.db.query<SendRow>(
    `select ${SEND_COLUMNS} from {{schema}}.kit_sends where id = $1`,
    [row.id],
  );
  return { ok: true, send: sendOf(rows[0]!) };
}
