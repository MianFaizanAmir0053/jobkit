import { createHash, randomBytes } from "node:crypto";

import { NextRequest, type NextResponse } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";
import { gmailConnection, gmailRefreshToken } from "@/server/gmail/connection";

import {
  disconnectGmail,
  finishGmailConnect,
  GMAIL_SEND_SCOPE,
  isGmailCallback,
  startGmailConnect,
} from "./gmailConnect";

/* Connecting the owner's Gmail for one-click send: decisions A20. */

const ORIGIN = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};
const key = randomBytes(32);

let db: PgliteDb;
let clock: FakeClock;

const deps = () => ({ db, clock, random: cryptoRandom, config, key });

/**
 * Google's token and revocation endpoints: a code is exchanged only with the
 * PKCE verifier its challenge came from, and the reply is what the consent
 * screen granted.
 */
const google = {
  pending: undefined as
    | { code: string; challenge: string; claims: object; scope: string; refresh: boolean }
    | undefined,
  revoked: [] as string[],
  revokeFails: false,
  reset() {
    this.pending = undefined;
    this.revoked = [];
    this.revokeFails = false;
  },
  consent(url: URL, opts: { claims?: object; scope?: string; refresh?: boolean } = {}): string {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.pending = {
      code,
      challenge: url.searchParams.get("code_challenge")!,
      claims: opts.claims ?? ownerClaims(),
      scope:
        opts.scope ?? `openid ${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
      refresh: opts.refresh ?? true,
    };
    return code;
  },
  endpoint: async (request: Request): Promise<Response> => {
    const body = new URLSearchParams(await request.text());
    if (request.url === "https://oauth2.googleapis.com/revoke") {
      if (google.revokeFails) return new Response("", { status: 503 });
      google.revoked.push(body.get("token") ?? "");
      return new Response("", { status: 200 });
    }
    const pending = google.pending;
    const challenge = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    if (!pending || body.get("code") !== pending.code || challenge !== pending.challenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    google.pending = undefined;
    return Response.json({
      access_token: "fixture-access-token",
      token_type: "Bearer",
      expires_in: 3599,
      scope: pending.scope,
      ...(pending.refresh ? { refresh_token: "fixture-refresh-token" } : {}),
      id_token: unsignedIdToken(pending.claims),
    });
  },
};

function unsignedIdToken(claims: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

function ownerClaims(overrides: object = {}): object {
  const now = clock.now().getTime() / 1000;
  return {
    iss: "https://accounts.google.com",
    aud: config.google.clientId,
    iat: now,
    exp: now + 3600,
    sub: "1001",
    email: "owner@example.com",
    email_verified: true,
    ...overrides,
  };
}

const cookieHeader = (cookies: Record<string, string | undefined>) =>
  Object.entries(cookies)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

async function googleSession(): Promise<string> {
  return (await issueSession(deps(), { kind: "google", label: "laptop" })).token;
}

/** The whole flow: start in the owner's browser, Google's consent, then the callback. */
async function connect(
  consent: { claims?: object; scope?: string; refresh?: boolean } = {},
): Promise<NextResponse> {
  const session = await googleSession();
  const start = await startGmailConnect(
    new NextRequest(`${ORIGIN}/api/auth/google/gmail`, {
      headers: { cookie: cookieHeader({ jobkit_session: session }) },
    }),
    deps(),
  );
  const url = new URL(start.headers.get("location")!);
  const code = google.consent(url, consent);
  const callback = new NextRequest(
    `${ORIGIN}/api/auth/google/callback?code=${code}&state=${url.searchParams.get("state")}`,
    {
      headers: {
        cookie: cookieHeader({
          jobkit_session: session,
          jobkit_gmail_state: start.cookies.get("jobkit_gmail_state")?.value,
          jobkit_gmail_verifier: start.cookies.get("jobkit_gmail_verifier")?.value,
        }),
      },
    },
  );
  expect(isGmailCallback(callback)).toBe(true);
  return finishGmailConnect(callback, deps());
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    "delete from {{schema}}.gmail_connection; delete from {{schema}}.sessions; delete from {{schema}}.owner;",
  );
  clock = fakeClock();
  google.reset();
  vi.stubGlobal("fetch", google.endpoint);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startGmailConnect", () => {
  it("asks Google for permission to send mail only, offline, for the owner's account, with PKCE", async () => {
    const session = await googleSession();
    const response = await startGmailConnect(
      new NextRequest(`${ORIGIN}/api/auth/google/gmail`, {
        headers: { cookie: cookieHeader({ jobkit_session: session }) },
      }),
      deps(),
    );

    const url = new URL(response.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(
      ["email", "openid", GMAIL_SEND_SCOPE].sort(),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("owner@example.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.cookies.get("jobkit_gmail_state")?.value).toBe(url.searchParams.get("state"));
  });

  it("sends a browser without a Google sign-in to sign in first, and refuses with no key set", async () => {
    const signedOut = await startGmailConnect(
      new NextRequest(`${ORIGIN}/api/auth/google/gmail`),
      deps(),
    );
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe(`${ORIGIN}/login?next=/devices`);

    const session = await googleSession();
    const keyless = await startGmailConnect(
      new NextRequest(`${ORIGIN}/api/auth/google/gmail`, {
        headers: { cookie: cookieHeader({ jobkit_session: session }) },
      }),
      { ...deps(), key: null },
    );
    expect(keyless.status).toBe(500);
  });
});

describe("finishGmailConnect", () => {
  it("keeps the owner's connection, its refresh token sealed, and goes back to Devices", async () => {
    const response = await connect();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/devices?gmail=connected`);
    expect(await gmailConnection(db)).toMatchObject({ email: "owner@example.com" });
    expect(await gmailRefreshToken(db, key)).toBe("fixture-refresh-token");
    expect(response.cookies.get("jobkit_gmail_state")?.value).toBe("");
  });

  it("keeps nothing for another account than the owner's", async () => {
    await connect();
    await db.exec("delete from {{schema}}.gmail_connection");

    const other = await connect({ claims: ownerClaims({ sub: "2002" }) });
    const stranger = await connect({ claims: ownerClaims({ email: "someone@example.com" }) });

    expect(other.headers.get("location")).toBe(`${ORIGIN}/devices?gmail=denied`);
    expect(stranger.headers.get("location")).toBe(`${ORIGIN}/devices?gmail=denied`);
    expect(await gmailConnection(db)).toBeNull();
  });

  it("keeps nothing when the owner left the permission to send unticked, or Google gave no refresh token", async () => {
    const unticked = await connect({
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
    });
    const tokenless = await connect({ refresh: false });

    expect(unticked.headers.get("location")).toBe(`${ORIGIN}/devices?gmail=no-send-permission`);
    expect(tokenless.headers.get("location")).toBe(`${ORIGIN}/devices?gmail=failed`);
    expect(await gmailConnection(db)).toBeNull();
  });

  it("tells a Gmail callback from a sign-in's by the state it carries", () => {
    const request = (state: string, cookies: Record<string, string>) =>
      new NextRequest(`${ORIGIN}/api/auth/google/callback?code=c&state=${state}`, {
        headers: { cookie: cookieHeader(cookies) },
      });

    expect(isGmailCallback(request("s1", { jobkit_gmail_state: "s1" }))).toBe(true);
    expect(isGmailCallback(request("s1", { jobkit_google_state: "s1" }))).toBe(false);
    expect(isGmailCallback(request("s2", { jobkit_gmail_state: "s1" }))).toBe(false);
  });
});

describe("disconnectGmail", () => {
  it("revokes the token at Google and forgets the connection, even when Google does not answer", async () => {
    await connect();
    const session = await googleSession();
    const request = () =>
      new NextRequest(`${ORIGIN}/api/gmail/disconnect`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: cookieHeader({ jobkit_session: session }) },
      });

    expect((await disconnectGmail(request(), deps())).status).toBe(200);
    expect(google.revoked).toEqual(["fixture-refresh-token"]);
    expect(await gmailConnection(db)).toBeNull();

    await connect();
    google.revokeFails = true;
    expect((await disconnectGmail(request(), deps())).status).toBe(200);
    expect(await gmailConnection(db)).toBeNull();
  });

  it("refuses another origin and a browser without a Google sign-in", async () => {
    await connect();
    const session = await googleSession();

    const foreign = await disconnectGmail(
      new NextRequest(`${ORIGIN}/api/gmail/disconnect`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie: cookieHeader({ jobkit_session: session }),
        },
      }),
      deps(),
    );
    const signedOut = await disconnectGmail(
      new NextRequest(`${ORIGIN}/api/gmail/disconnect`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
      deps(),
    );

    expect([foreign.status, signedOut.status]).toEqual([403, 401]);
    expect(await gmailConnection(db)).not.toBeNull();
  });
});
