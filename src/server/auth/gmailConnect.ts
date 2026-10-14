import { decodeIdToken, generateCodeVerifier, generateState, Google } from "arctic";
import { NextResponse, type NextRequest } from "next/server";

import { identityFromIdToken } from "@/core/platform/googleIdentity";
import { admitOwner } from "@/core/platform/owner";
import { checkRequirements, findSession, type SessionDeps } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { dropGmailConnection, keepGmailConnection } from "@/server/gmail/connection";
import { heldToken, NO_STORE, refusal, sessionForChange } from "@/server/http";

/**
 * Connecting the owner's Gmail for one-click send (decisions A20): the
 * authorization-code flow with PKCE, as sign-in has it, asking Google for
 * `gmail.send` alone besides `openid email`, offline so a refresh token
 * comes back. It starts only from a Google sign-in, returns through the
 * callback sign-in already registers (the state it carries tells the two
 * apart), and keeps the token, sealed, only for the owner's own account
 * and only when the owner left the permission to send ticked.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const FLOW_PATH = "/api/auth/google";
const FLOW_MAX_AGE_SECONDS = 10 * 60;
const STATE_COOKIE = "jobkit_gmail_state";
const VERIFIER_COOKIE = "jobkit_gmail_verifier";
const RETURN = "/devices";

export interface GmailConnectDeps extends SessionDeps {
  config: AppConfig;
  /** GMAIL_TOKEN_KEY, read; null when it is not set. */
  key: Buffer | null;
}

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

/** Whether a sign-in callback is this flow's: its state is the one this flow set. */
export function isGmailCallback(request: NextRequest): boolean {
  const state = request.nextUrl.searchParams.get("state");
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  return Boolean(state && expected && state === expected);
}

async function signedInWithGoogle(request: NextRequest, deps: SessionDeps): Promise<boolean> {
  const found = await findSession(deps, heldToken(request));
  return found.ok && checkRequirements(found.session, deps.clock.now(), { kind: "google" }).ok;
}

export async function startGmailConnect(
  request: NextRequest,
  deps: GmailConnectDeps,
): Promise<NextResponse> {
  const { config } = deps;
  if (!config.google.clientId || !config.google.clientSecret) {
    return new NextResponse(
      "Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      { status: 500 },
    );
  }
  if (!deps.key) {
    return new NextResponse(
      "One-click send is not configured: set GMAIL_TOKEN_KEY (docs/runbook/setup.md).",
      { status: 500 },
    );
  }
  if (!(await signedInWithGoogle(request, deps))) {
    return NextResponse.redirect(new URL(`/login?next=${RETURN}`, config.appOrigin), 303);
  }
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = googleClient(config).createAuthorizationURL(state, verifier, [
    "openid",
    "email",
    GMAIL_SEND_SCOPE,
  ]);
  // A refresh token comes back only for offline access, and again only on consent.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("login_hint", config.ownerEmail);

  const response = NextResponse.redirect(url);
  response.cookies.set(flowCookie(STATE_COOKIE, state));
  response.cookies.set(flowCookie(VERIFIER_COOKIE, verifier));
  return response;
}

type Refusal = "failed" | "denied" | "no-send-permission";

export async function finishGmailConnect(
  request: NextRequest,
  deps: GmailConnectDeps,
): Promise<NextResponse> {
  const { config, clock, key } = deps;
  const code = request.nextUrl.searchParams.get("code");
  const verifier = request.cookies.get(VERIFIER_COOKIE)?.value;
  if (!code || !verifier || !isGmailCallback(request)) {
    return refuse(config, "failed", "the state or verifier did not match");
  }
  if (!key) return refuse(config, "failed", "GMAIL_TOKEN_KEY is not set");
  if (!(await signedInWithGoogle(request, deps))) {
    return refuse(config, "denied", "the browser has no Google sign-in");
  }

  let tokens: Awaited<ReturnType<Google["validateAuthorizationCode"]>>;
  let claims: unknown;
  try {
    tokens = await googleClient(config).validateAuthorizationCode(code, verifier);
    claims = decodeIdToken(tokens.idToken());
  } catch (error) {
    return refuse(config, "failed", error instanceof Error ? error.message : "the exchange failed");
  }
  const read = identityFromIdToken(claims, { clientId: config.google.clientId, now: clock.now() });
  if (!read.ok) return refuse(config, "failed", `the ID token was ${read.reason}`);
  const admitted = await admitOwner(deps, read.identity, config.ownerEmail);
  if (!admitted.ok) return refuse(config, "denied", admitted.reason);
  // Google's consent screen lets the owner untick a permission and still go on.
  const scopes = tokens.hasScopes() ? tokens.scopes() : [];
  if (!scopes.includes(GMAIL_SEND_SCOPE)) {
    return refuse(config, "no-send-permission", "the permission to send was not granted");
  }
  if (!tokens.hasRefreshToken()) return refuse(config, "failed", "Google sent no refresh token");

  await keepGmailConnection(deps, key, {
    email: read.identity.email,
    refreshToken: tokens.refreshToken(),
    scopes,
  });
  const response = NextResponse.redirect(
    new URL(`${RETURN}?gmail=connected`, config.appOrigin),
    303,
  );
  clearFlowCookies(response);
  return response;
}

/** POST /api/gmail/disconnect: forgets the connection, and revokes its token at Google if Google answers. */
export async function disconnectGmail(
  request: NextRequest,
  deps: GmailConnectDeps,
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  if (!deps.key) return refusal(500, "not-configured");
  const token = await dropGmailConnection(deps.db, deps.key);
  if (token) {
    try {
      await googleClient(deps.config).revokeToken(token);
    } catch (error) {
      // The connection is gone either way; the owner can also revoke it in their Google account.
      console.warn(
        `Revoking the Gmail token failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}

/** The reason goes to the server log; the browser sees only a code. */
function refuse(config: AppConfig, error: Refusal, reason: string): NextResponse {
  console.warn(`Connecting Gmail refused: ${reason}`);
  const response = NextResponse.redirect(
    new URL(`${RETURN}?gmail=${error}`, config.appOrigin),
    303,
  );
  clearFlowCookies(response);
  return response;
}

function clearFlowCookies(response: NextResponse): void {
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE]) response.cookies.set(flowCookie(name, "", 0));
}
