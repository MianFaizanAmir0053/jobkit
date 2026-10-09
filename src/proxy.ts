import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/server/sessionCookie";

/**
 * An optimistic check only (platform spec B2): a page request with no
 * session cookie goes to /login. The real check is `requireSession` in the
 * data access layer, because Next documents that the proxy can be skipped.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Pages only: not /login or /pair (exactly, or below them), not the API
  // (its routes answer for themselves), not Next's own paths (they start
  // with _), and no path containing a dot: the manifest, the icons and the
  // service worker. No page of the app has a dot in its path.
  matcher: ["/((?!_|api/|login(?:/|$)|pair(?:/|$)|.*\\.).*)"],
};
