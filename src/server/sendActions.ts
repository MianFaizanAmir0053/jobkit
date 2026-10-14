import { NextResponse, type NextRequest } from "next/server";
import { z, type ZodType } from "zod";

import { chosenRole } from "@/core/extraction/owner";
import type { Clock, Db, GmailSender, Storage } from "@/core/ports";
import { asShown, type KitSend, latestSend, showsFor, UNDO_MS } from "@/core/review/kitSends";
import { type DeliverOutcome, deliverSend, scheduleSend, undoSend } from "@/core/review/send";
import { isUuid } from "@/lib/uuid";
import { type AppConfig, appConfig } from "@/server/config";
import type { Container } from "@/server/container";
import { gmailConnection } from "@/server/gmail/connection";
import { connectedGmail } from "@/server/gmail/sender";
import { NO_STORE, readLimited, refusal, sessionForChange, sessionForRead } from "@/server/http";

/**
 * "Approve & send" on the job page (decisions A20): the press, Undo, the
 * page's nudge to deliver as its countdown ends, and the send as it stands,
 * for the page to follow. Each needs an approved session, and each change
 * the app's own origin. The press schedules the delivery with after(), so
 * the email goes though the page is closed, while the server runs; the
 * page's nudge covers a server that restarted meanwhile. Either way it goes
 * once, and a try that meets a dropped database connection is tried again.
 */

export type SendDeps = {
  db: Db;
  clock: Clock;
  storage: Storage;
  config: AppConfig;
  /** The owner's Gmail; null when it is not connected. */
  gmail: () => Promise<GmailSender | null>;
  /** Next's after() in the app: the delivery waits out the countdown once the response has gone. */
  schedule: (task: () => Promise<unknown>) => void;
  /** Waits, as the delivery waits out the countdown; tests move their clock instead. */
  sleep?: (ms: number) => Promise<void>;
};

const MAX_BODY_BYTES = 1024;

const ok = (status: number, body: object) => NextResponse.json(body, { status, headers: NO_STORE });

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The send as the page shows it, one a stopped server left behind as it now
 * stands, with what is left of its countdown by the server's clock.
 */
function shown(stored: KitSend, now: Date) {
  const send = asShown(stored, now);
  return {
    id: send.id,
    kit: send.kit,
    status: send.status,
    to: send.to,
    leftMs: Math.max(0, send.sendAt.getTime() - now.getTime()),
    messageId: send.messageId,
    error: send.error,
  };
}

/** The request's JSON body, as the schema reads it; a refusal for any other. */
async function bodyOf<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === "too-large") return { ok: false, response: refusal(413, "too-large") };
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, response: refusal(400, "invalid") };
}

/**
 * One delivery, tried again after a throw, as a dropped database connection
 * gives: a claim taken before the throw leaves the send sending, which the
 * next try leaves alone, so it never goes twice.
 */
async function tryDeliver(deps: SendDeps, jobId: string, sendId: string): Promise<DeliverOutcome> {
  const sleep = deps.sleep ?? wait;
  for (let tries = 1; ; tries++) {
    try {
      return await deliverSend(deps, jobId, sendId);
    } catch (error) {
      if (tries >= 3) throw error;
      await sleep(1_000 * tries);
    }
  }
}

/** Delivers once the countdown is over, waiting out what is left of it, ten seconds at most. */
async function deliverWhenDue(
  deps: SendDeps,
  jobId: string,
  sendId: string,
): Promise<DeliverOutcome> {
  const sleep = deps.sleep ?? wait;
  let outcome = await tryDeliver(deps, jobId, sendId);
  for (let tries = 0; tries < 3 && !outcome.ok && outcome.reason === "not-due"; tries++) {
    const left = outcome.send.sendAt.getTime() - deps.clock.now().getTime();
    await sleep(Math.min(Math.max(left, 0), UNDO_MS) + 50);
    outcome = await tryDeliver(deps, jobId, sendId);
  }
  return outcome;
}

/** The kit, the address and the send that may have gone, as the page showed them at the press. */
const sendBody = z.object({
  kit: z.string().min(1).max(100),
  to: z.string().max(400),
  uncertain: z.uuid().nullable(),
});

/**
 * POST /api/jobs/<id>/send: "Approve & send", answered with the send and
 * its countdown; refused while Gmail is not connected or jobkit can no
 * longer use it, while a hard stop holds the kit, or when the page showed
 * another kit or address.
 */
export async function send(
  request: NextRequest,
  deps: SendDeps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const body = await bodyOf(request, sendBody);
  if (!body.ok) return body.response;
  const connection = await gmailConnection(deps.db);
  if (!connection) return refusal(409, "gmail-not-connected");
  if (connection.refusedAt) return refusal(409, "gmail-refused");
  const scheduled = await scheduleSend(deps, jobId, {
    ...body.data,
    sessionId: actor.session.id,
  });
  if (!scheduled.ok) {
    return refusal(scheduled.reason === "not-found" ? 404 : 409, scheduled.reason);
  }
  const sendId = scheduled.send.id;
  deps.schedule(() => deliverWhenDue(deps, jobId, sendId));
  return ok(202, { send: shown(scheduled.send, deps.clock.now()) });
}

const sendIdBody = z.object({ sendId: z.uuid() });

/** POST /api/jobs/<id>/send/undo: stops the send while it counts down. */
export async function undo(
  request: NextRequest,
  deps: SendDeps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const body = await bodyOf(request, sendIdBody);
  if (!body.ok) return body.response;
  const undone = await undoSend(deps, jobId, body.data.sendId);
  if (!undone.ok) return refusal(undone.reason === "not-found" ? 404 : 409, undone.reason);
  return ok(200, { ok: true });
}

/**
 * POST /api/jobs/<id>/send/deliver: the page's nudge as its countdown
 * ends, answered with the send as it then stands. A send another delivery
 * took is left to it.
 */
export async function deliver(
  request: NextRequest,
  deps: SendDeps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const body = await bodyOf(request, sendIdBody);
  if (!body.ok) return body.response;
  const outcome = await deliverWhenDue(deps, jobId, body.data.sendId);
  if (!outcome.ok) return refusal(outcome.reason === "not-found" ? 404 : 409, outcome.reason);
  return ok(200, { send: shown(outcome.send, deps.clock.now()) });
}

/**
 * GET /api/jobs/<id>/send?kit=<kit>: the chosen role's send as it now
 * stands, for the page to follow: the one the page shows beside the kit it
 * names, so the two never disagree about an earlier kit's send.
 */
export async function sendState(
  request: NextRequest,
  deps: SendDeps,
  jobId: string,
): Promise<NextResponse> {
  const actor = await sessionForRead(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  const role = await chosenRole(deps.db, jobId);
  const latest = role ? await latestSend(deps.db, jobId, role.id) : null;
  const now = deps.clock.now();
  const kit = request.nextUrl.searchParams.get("kit");
  const showing = latest && (kit === null || showsFor(asShown(latest, now), kit)) ? latest : null;
  return ok(200, { send: showing && shown(showing, now) });
}

/** The app's wiring: the container, the config, the owner's Gmail, and after() to deliver. */
export function appSendDeps(container: Container, schedule: SendDeps["schedule"]): SendDeps {
  const config = appConfig();
  return {
    ...container,
    config,
    gmail: () =>
      connectedGmail({ db: container.db, clock: container.clock, kind: container.kind, config }),
    schedule,
  };
}
