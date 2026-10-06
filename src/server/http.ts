import { NextResponse, type NextRequest } from "next/server";

import { findSession, type Session, type SessionDeps } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { isSameOrigin } from "@/server/origin";
import { SESSION_COOKIE } from "@/server/sessionCookie";

/** Answers about sessions and pairing are never cached anywhere. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function refusal(status: number, error: string, extra: object = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export function heldToken(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE)?.value;
}

/**
 * What every state-changing route checks first (platform spec B2): the
 * request comes from the app's own origin and carries a live, approved
 * session. Routes then check what the action itself needs.
 */
export async function sessionForChange(
  request: NextRequest,
  deps: Pick<SessionDeps, "db" | "clock"> & { config: AppConfig },
): Promise<{ ok: true; session: Session } | { ok: false; response: NextResponse }> {
  if (!isSameOrigin(request, deps.config.appOrigin)) {
    return { ok: false, response: refusal(403, "forbidden") };
  }
  const found = await findSession(deps, heldToken(request));
  if (!found.ok) return { ok: false, response: refusal(401, "signed-out") };
  return { ok: true, session: found.session };
}

/** The request's JSON body, or null when it is missing or not JSON. */
export async function jsonBody(request: NextRequest): Promise<unknown> {
  return request.json().catch(() => null);
}
