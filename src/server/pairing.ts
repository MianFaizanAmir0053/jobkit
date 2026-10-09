import { NextResponse, userAgent, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { z } from "zod";

import {
  approvePairing,
  createPairingToken,
  PAIRING_TOKEN_LIFETIME_MS,
  pairingStatus,
  redeemPairingToken,
  rejectPairing,
  waitingPhones,
} from "@/core/platform/pairing";
import {
  deviceLabel,
  findSession,
  remainingSeconds,
  type SessionDeps,
} from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import {
  heldToken,
  jsonBody,
  NO_STORE,
  refusal,
  sessionForChange,
  sessionForRead,
} from "@/server/http";
import { isSameOrigin } from "@/server/origin";
import { sessionCookie } from "@/server/sessionCookie";

/**
 * The pairing routes (platform spec B3). The token travels only in the QR
 * code's URL fragment and in request bodies: never in a query string, so it
 * never reaches a server log.
 */
export interface PairingDeps extends SessionDeps {
  config: AppConfig;
}

export const REDEEM_FAILURE = "This code has expired. Make a new one on your laptop.";

/** POST /api/pair/tokens: a QR code for /pair#t=<token>, from a google session. */
export async function createToken(request: NextRequest, deps: PairingDeps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const made = await createPairingToken(deps, actor.session);
  if (!made.ok) return refusal(403, made.reason);
  const url = `${deps.config.appOrigin}/pair#t=${made.token}`;
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return NextResponse.json(
    // The phone-facing countdown runs on the lifetime, not on the laptop's clock.
    {
      url,
      svg,
      expiresAt: made.expiresAt.toISOString(),
      expiresInSeconds: PAIRING_TOKEN_LIFETIME_MS / 1000,
    },
    { status: 201, headers: NO_STORE },
  );
}

const redeemBody = z.object({ token: z.string().min(1).max(100) });

/** POST /api/pair/redeem: the phone's side. Every failure gives the same answer. */
export async function redeem(request: NextRequest, deps: PairingDeps): Promise<NextResponse> {
  const fail = () => refusal(400, REDEEM_FAILURE);
  if (!isSameOrigin(request, deps.config.appOrigin)) return fail();
  const body = redeemBody.safeParse(await jsonBody(request));
  if (!body.success) return fail();

  try {
    const held = heldToken(request);
    if (held) {
      const found = await findSession(deps, held);
      // A browser signed in with Google keeps that session, and the token stays usable by the phone.
      if (found.ok && found.session.kind === "google") return fail();
    }
    // A phone pairing again replaces the session it held, in the same transaction.
    const redemption = await redeemPairingToken(
      deps,
      body.data.token,
      deviceLabel(userAgent(request)),
      held,
    );
    if (!redemption.ok) return fail();

    const response = NextResponse.json({ code: redemption.code }, { headers: NO_STORE });
    const { issued } = redemption;
    response.cookies.set(
      sessionCookie(issued.token, remainingSeconds(issued.session, deps.clock.now())),
    );
    return response;
  } catch (error) {
    // A deadlock, a dropped connection or a bug answers like any other
    // failure. The log keeps the whole error, which never holds the token:
    // database errors carry no query parameters.
    console.error("Pairing redemption failed:", error);
    return fail();
  }
}

/** GET /api/pair/status: what the phone polls while it shows its code. */
export async function status(request: NextRequest, deps: PairingDeps): Promise<NextResponse> {
  const state = await pairingStatus(deps, heldToken(request));
  return NextResponse.json({ state }, { headers: NO_STORE });
}

/** GET /api/pair/waiting: the phones waiting for this google session to type their code. */
export async function waiting(request: NextRequest, deps: PairingDeps): Promise<NextResponse> {
  const viewer = await sessionForRead(request, deps, { kind: "google" });
  if (!viewer.ok) return viewer.response;
  const phones = await waitingPhones(deps, viewer.session);
  return NextResponse.json(
    { phones: phones.map((p) => ({ ...p, redeemedAt: p.redeemedAt.toISOString() })) },
    { headers: NO_STORE },
  );
}

const approveBody = z.object({ pairingId: z.uuid(), code: z.string().max(20) });

/** POST /api/pair/approve: the laptop types the phone's code. */
export async function approve(request: NextRequest, deps: PairingDeps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = approveBody.safeParse(await jsonBody(request));
  if (!body.success) return refusal(400, "bad-request");
  const result = await approvePairing(deps, actor.session, body.data.pairingId, body.data.code);
  if (result.ok) return NextResponse.json({ ok: true }, { headers: NO_STORE });
  if (result.reason === "wrong-code") {
    return refusal(400, "wrong-code", { attemptsLeft: result.attemptsLeft });
  }
  if (result.reason === "gone") return refusal(410, "gone");
  return refusal(403, result.reason);
}

const rejectBody = z.object({ pairingId: z.uuid() });

/** POST /api/pair/reject: deletes the waiting phone's session. */
export async function reject(request: NextRequest, deps: PairingDeps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = rejectBody.safeParse(await jsonBody(request));
  if (!body.success) return refusal(400, "bad-request");
  const rejected = await rejectPairing(deps, actor.session, body.data.pairingId);
  return rejected ? new NextResponse(null, { status: 204 }) : refusal(410, "gone");
}
