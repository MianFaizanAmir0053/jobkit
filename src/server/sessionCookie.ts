/**
 * The session cookie (platform spec B2): HttpOnly, Secure, SameSite=Lax and
 * Path=/, with Max-Age equal to the session's remaining life. Browsers treat
 * http://localhost as secure, so Secure holds in development too. Lax lets
 * the cookie ride along when Google redirects back to the callback, which is
 * how re-authentication finds the session it renews.
 */
export const SESSION_COOKIE = "jobkit_session";

export function sessionCookie(token: string, maxAgeSeconds: number) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  } as const;
}

export function clearedSessionCookie() {
  return sessionCookie("", 0);
}
