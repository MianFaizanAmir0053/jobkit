import { NextResponse, type NextRequest } from "next/server";

import {
  checkRequirements,
  findSession,
  type Session,
  type SessionDeps,
  type SessionRequirements,
} from "@/core/platform/sessions";
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

type Checked = { ok: true; session: Session } | { ok: false; response: NextResponse };
type Deps = Pick<SessionDeps, "db" | "clock">;

/**
 * The route handlers' twin of `requireSession` (platform spec B2): the same
 * lookup and the same `checkRequirements`, answering 401 or 403 instead of
 * redirecting. Every route that reads the owner's data calls it.
 */
export async function sessionForRead(
  request: NextRequest,
  deps: Deps,
  require: SessionRequirements = {},
): Promise<Checked> {
  const found = await findSession(deps, heldToken(request));
  if (!found.ok) return { ok: false, response: refusal(401, "signed-out") };
  const met = checkRequirements(found.session, deps.clock.now(), require);
  if (!met.ok) return { ok: false, response: refusal(403, met.reason) };
  return { ok: true, session: met.session };
}

/** For routes that change state: the app's own Origin first, then the same checks. */
export async function sessionForChange(
  request: NextRequest,
  deps: Deps & { config: AppConfig },
  require: SessionRequirements = {},
): Promise<Checked> {
  if (!isSameOrigin(request, deps.config.appOrigin)) {
    return { ok: false, response: refusal(403, "forbidden") };
  }
  return sessionForRead(request, deps, require);
}

/** The request's JSON body, or null when it is missing or not JSON. */
export async function jsonBody(request: NextRequest): Promise<unknown> {
  return request.json().catch(() => null);
}
