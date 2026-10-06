import { NextResponse, type NextRequest } from "next/server";

import { endSession } from "@/core/platform/sessions";
import type { Db } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { isSameOrigin } from "@/server/origin";
import { clearedSessionCookie, SESSION_COOKIE } from "@/server/sessionCookie";

/** Sign out (platform spec B2): deletes the session's row and clears its cookie. */
export async function signOut(
  request: NextRequest,
  deps: { db: Db; config: AppConfig },
): Promise<NextResponse> {
  if (!isSameOrigin(request, deps.config.appOrigin)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) await endSession(deps.db, token);
  const response = NextResponse.redirect(new URL("/login", deps.config.appOrigin), 303);
  response.cookies.set(clearedSessionCookie());
  return response;
}
