import { decodeIdToken, generateCodeVerifier, generateState, Google } from "arctic";
import { NextResponse, userAgent, type NextRequest } from "next/server";

import { identityFromIdToken } from "@/core/platform/googleIdentity";
import { admitOwner } from "@/core/platform/owner";
import {
  deviceLabel,
  endSession,
  findSession,
  issueSession,
  reauthenticate,
  remainingSeconds,
  type IssuedSession,
  type SessionDeps,
} from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { SESSION_COOKIE, sessionCookie } from "@/server/sessionCookie";

/**
 * Google sign-in (platform spec B2) with arctic 3: the authorization-code
 * flow with PKCE, asking for openid and email only. The state, the verifier
 * and the page to return to live in short-lived HttpOnly cookies that only
 * these two routes receive.
 */
export interface GoogleSignInDeps extends SessionDeps {
  config: AppConfig;
}

const FLOW_PATH = "/api/auth/google";
const FLOW_MAX_AGE_SECONDS = 10 * 60;
const STATE_COOKIE = "jobkit_google_state";
const VERIFIER_COOKIE = "jobkit_google_verifier";
const RETURN_COOKIE = "jobkit_google_return";
const DEFAULT_RETURN = "/jobs";

function googleClient(config: AppConfig): Google {
  return new Google(
    config.google.clientId,
    config.google.clientSecret,
    `${config.appOrigin}${FLOW_PATH}/callback`,
  );
}

function flowCookie(name: string, value: string, maxAge = FLOW_MAX_AGE_SECONDS) {
  return {
    name,
    value,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: FLOW_PATH,
    maxAge,
  } as const;
}

/** Only this app's own paths, so a crafted link can never send the owner elsewhere. */
function safeReturnPath(path: string | null | undefined, appOrigin: string): string {
  if (!path || !/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path)) return DEFAULT_RETURN;
  return new URL(path, appOrigin).origin === appOrigin ? path : DEFAULT_RETURN;
}

export function startGoogleSignIn(request: NextRequest, deps: { config: AppConfig }): NextResponse {
  const { config } = deps;
  if (!config.google.clientId || !config.google.clientSecret) {
    return new NextResponse(
      "Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      { status: 500 },
    );
  }
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = googleClient(config).createAuthorizationURL(state, verifier, ["openid", "email"]);
  // The account chooser every time, so the owner always sees which account signs in.
  url.searchParams.set("prompt", "select_account");

  const response = NextResponse.redirect(url);
  response.cookies.set(flowCookie(STATE_COOKIE, state));
  response.cookies.set(flowCookie(VERIFIER_COOKIE, verifier));
  const next = request.nextUrl.searchParams.get("next");
  response.cookies.set(flowCookie(RETURN_COOKIE, safeReturnPath(next, config.appOrigin)));
  return response;
}

export async function finishGoogleSignIn(
  request: NextRequest,
  deps: GoogleSignInDeps,
): Promise<NextResponse> {
  const { config, clock } = deps;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const verifier = request.cookies.get(VERIFIER_COOKIE)?.value;
  if (!code || !state || !expectedState || !verifier || state !== expectedState) {
    return refuse(config, "failed", "the state or verifier did not match");
  }

  let claims: unknown;
  try {
    const tokens = await googleClient(config).validateAuthorizationCode(code, verifier);
    claims = decodeIdToken(tokens.idToken());
  } catch (error) {
    // Google refusing the code, an unreachable endpoint and a malformed reply end the same way.
    return refuse(config, "failed", error instanceof Error ? error.message : "the exchange failed");
  }
  const read = identityFromIdToken(claims, { clientId: config.google.clientId, now: clock.now() });
  if (!read.ok) return refuse(config, "failed", `the ID token was ${read.reason}`);
  const admitted = await admitOwner(deps, read.identity, config.ownerEmail);
  if (!admitted.ok) return refuse(config, "denied", admitted.reason);

  const issued = await renewOrIssue(request, deps);
  const returnTo = safeReturnPath(request.cookies.get(RETURN_COOKIE)?.value, config.appOrigin);
  const response = NextResponse.redirect(new URL(returnTo, config.appOrigin), 303);
  response.cookies.set(sessionCookie(issued.token, remainingSeconds(issued.session, clock.now())));
  clearFlowCookies(response);
  return response;
}

/**
 * Inside a live google session this is re-authentication (B2): the same row
 * gets a new token. Anything else the browser holds (a paired phone's
 * session, an ended one) is deleted and replaced, never left behind.
 */
async function renewOrIssue(request: NextRequest, deps: GoogleSignInDeps): Promise<IssuedSession> {
  const held = request.cookies.get(SESSION_COOKIE)?.value;
  if (held) {
    const found = await findSession(deps, held);
    if (found.ok && found.session.kind === "google") {
      const renewed = await reauthenticate(deps, found.session.id);
      if (renewed) return renewed;
    }
    await endSession(deps.db, held);
  }
  return issueSession(deps, { kind: "google", label: deviceLabel(userAgent(request)) });
}

/** The reason goes to the server log as a code; the browser sees only denied or failed. */
function refuse(config: AppConfig, error: "failed" | "denied", reason: string): NextResponse {
  console.warn(`Google sign-in refused: ${reason}`);
  const response = NextResponse.redirect(new URL(`/login?error=${error}`, config.appOrigin), 303);
  clearFlowCookies(response);
  return response;
}

function clearFlowCookies(response: NextResponse): void {
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE, RETURN_COOKIE]) {
    response.cookies.set(flowCookie(name, "", 0));
  }
}
