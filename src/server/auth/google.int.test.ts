import { createHash } from "node:crypto";

import { NextRequest, type NextResponse } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { findSession, hashToken, issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { finishGoogleSignIn, startGoogleSignIn, type GoogleSignInDeps } from "./google";

const ORIGIN = "http://localhost:3000";
const DAY = 24 * 60 * 60 * 1000;
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
let clock: FakeClock;
let deps: GoogleSignInDeps;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.sessions; delete from {{schema}}.owner;");
  clock = fakeClock();
  deps = { db, clock, random: cryptoRandom, config };
  google.reset();
  vi.stubGlobal("fetch", google.tokenEndpoint);
  // Refusals log a reason code; keep the test output quiet.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A fake of Google's token endpoint: it hands out the ID token for the code
 * the fake consent screen issued, only when the PKCE verifier matches the
 * challenge the start route sent.
 */
const google = {
  pending: undefined as { code: string; challenge: string; claims: object } | undefined,
  calls: 0,
  reset() {
    this.pending = undefined;
    this.calls = 0;
  },
  consent(authorizationUrl: URL, claims: object): string {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.pending = {
      code,
      challenge: authorizationUrl.searchParams.get("code_challenge")!,
      claims,
    };
    return code;
  },
  tokenEndpoint: async (request: Request): Promise<Response> => {
    google.calls += 1;
    const body = new URLSearchParams(await request.text());
    const verifier = body.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const pending = google.pending;
    if (
      request.url !== "https://oauth2.googleapis.com/token" ||
      !pending ||
      body.get("code") !== pending.code ||
      challenge !== pending.challenge
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    google.pending = undefined;
    return Response.json({
      access_token: "access",
      token_type: "Bearer",
      expires_in: 3599,
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

function cookieHeader(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** The cookies a response sets, by name, with their raw attributes. */
function setCookies(response: Response): Map<string, string> {
  return new Map(response.headers.getSetCookie().map((line) => [line.split("=")[0]!, line]));
}

function cookieValue(response: NextResponse, name: string): string | undefined {
  return response.cookies.get(name)?.value;
}

/** Runs the whole flow: start, Google's consent, then the callback. */
async function signIn(
  opts: { claims?: object; sessionToken?: string; next?: string } = {},
): Promise<NextResponse> {
  const startUrl = `${ORIGIN}/api/auth/google/start${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ""}`;
  const start = startGoogleSignIn(new NextRequest(startUrl), deps);
  const authorizationUrl = new URL(start.headers.get("location")!);
  const code = google.consent(authorizationUrl, opts.claims ?? ownerClaims());
  const state = authorizationUrl.searchParams.get("state")!;
  const callback = new NextRequest(
    `${ORIGIN}/api/auth/google/callback?code=${code}&state=${state}`,
    {
      headers: {
        "user-agent": WINDOWS_CHROME,
        cookie: cookieHeader({
          jobkit_google_state: cookieValue(start, "jobkit_google_state"),
          jobkit_google_verifier: cookieValue(start, "jobkit_google_verifier"),
          jobkit_google_return: cookieValue(start, "jobkit_google_return"),
          jobkit_session: opts.sessionToken,
        }),
      },
    },
  );
  return finishGoogleSignIn(callback, deps);
}

async function sessionRows(): Promise<{ id: string; token_hash: string; label: string }[]> {
  return (
    await db.query<{ id: string; token_hash: string; label: string }>(
      "select id, token_hash, label from {{schema}}.sessions",
    )
  ).rows;
}

describe("startGoogleSignIn", () => {
  it("sends the browser to Google's account chooser for openid and email only, with PKCE", () => {
    const response = startGoogleSignIn(new NextRequest(`${ORIGIN}/api/auth/google/start`), deps);

    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: `${ORIGIN}/api/auth/google/callback`,
      scope: "openid email",
      prompt: "select_account",
      code_challenge_method: "S256",
    });
    expect(location.searchParams.get("state")).toBe(cookieValue(response, "jobkit_google_state"));
  });

  it("keeps the state and the verifier in short-lived HttpOnly cookies for the sign-in routes only", () => {
    const response = startGoogleSignIn(new NextRequest(`${ORIGIN}/api/auth/google/start`), deps);

    for (const name of ["jobkit_google_state", "jobkit_google_verifier"]) {
      const cookie = setCookies(response).get(name)!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=lax/i);
      expect(cookie).toMatch(/Path=\/api\/auth\/google(;|$)/);
      expect(cookie).toMatch(/Max-Age=600/);
    }
  });

  it("says plainly when the Google client is not configured", async () => {
    const response = startGoogleSignIn(new NextRequest(`${ORIGIN}/api/auth/google/start`), {
      ...deps,
      config: { ...config, google: { clientId: "", clientSecret: "" } },
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/GOOGLE_CLIENT_ID/);
  });
});

describe("finishGoogleSignIn", () => {
  it("signs the owner in: a google session whose row holds only the token's hash", async () => {
    const response = await signIn();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/jobs`);
    const token = cookieValue(response, "jobkit_session")!;
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.label).toBe("Windows · Chrome");
    expect(await findSession(deps, token)).toMatchObject({ ok: true, session: { kind: "google" } });
  });

  it("sets the session cookie HttpOnly, Secure, SameSite=Lax, Path=/, for the session's 30 days", async () => {
    const cookie = setCookies(await signIn()).get("jobkit_session")!;

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\/(;|$)/);
    expect(cookie).toMatch(new RegExp(`Max-Age=${(30 * DAY) / 1000}(;|$)`));
  });

  it("clears the sign-in cookies once the callback has run", async () => {
    const cookies = setCookies(await signIn());

    for (const name of ["jobkit_google_state", "jobkit_google_verifier", "jobkit_google_return"]) {
      expect(cookies.get(name)).toMatch(/Max-Age=0/);
    }
  });

  it("refuses any other Google account, an unverified email, and a different sub after the first sign-in", async () => {
    await signIn();
    await db.exec("delete from {{schema}}.sessions");

    for (const claims of [
      ownerClaims({ sub: "3003", email: "someone@example.com" }),
      ownerClaims({ email_verified: false }),
      ownerClaims({ sub: "2002" }),
    ]) {
      const response = await signIn({ claims });

      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=denied`);
      expect(cookieValue(response, "jobkit_session")).toBeUndefined();
    }
    expect(await sessionRows()).toEqual([]);
  });

  it("refuses an ID token issued to another app", async () => {
    const response = await signIn({ claims: ownerClaims({ aud: "another-app" }) });

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=failed`);
    expect(await sessionRows()).toEqual([]);
  });

  it("refuses a callback whose state does not match its cookie, without asking Google", async () => {
    const start = startGoogleSignIn(new NextRequest(`${ORIGIN}/api/auth/google/start`), deps);
    const code = google.consent(new URL(start.headers.get("location")!), ownerClaims());
    const forged = new NextRequest(`${ORIGIN}/api/auth/google/callback?code=${code}&state=forged`, {
      headers: {
        cookie: cookieHeader({
          jobkit_google_state: cookieValue(start, "jobkit_google_state"),
          jobkit_google_verifier: cookieValue(start, "jobkit_google_verifier"),
        }),
      },
    });

    const response = await finishGoogleSignIn(forged, deps);

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=failed`);
    expect(google.calls).toBe(0);
    expect(await sessionRows()).toEqual([]);
  });

  it("refuses a callback without the verifier cookie, and one Google rejects", async () => {
    const start = startGoogleSignIn(new NextRequest(`${ORIGIN}/api/auth/google/start`), deps);
    const state = cookieValue(start, "jobkit_google_state")!;
    const code = google.consent(new URL(start.headers.get("location")!), ownerClaims());
    const callback = (cookies: Record<string, string | undefined>, withCode = code) =>
      finishGoogleSignIn(
        new NextRequest(`${ORIGIN}/api/auth/google/callback?code=${withCode}&state=${state}`, {
          headers: { cookie: cookieHeader({ jobkit_google_state: state, ...cookies }) },
        }),
        deps,
      );

    const noVerifier = await callback({});
    const rejected = await callback(
      { jobkit_google_verifier: cookieValue(start, "jobkit_google_verifier") },
      "a-code-google-never-issued",
    );

    for (const response of [noVerifier, rejected]) {
      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=failed`);
    }
    expect(await sessionRows()).toEqual([]);
  });

  it("re-authenticates inside a google session: same row, new token, old token dead, end date kept", async () => {
    const first = await signIn();
    const firstToken = cookieValue(first, "jobkit_session")!;
    const [row] = await sessionRows();
    clock.advance(10 * DAY);

    const again = await signIn({ sessionToken: firstToken });

    const secondToken = cookieValue(again, "jobkit_session")!;
    expect(secondToken).not.toBe(firstToken);
    expect((await sessionRows()).map((r) => r.id)).toEqual([row!.id]);
    expect(await findSession(deps, firstToken)).toEqual({ ok: false, reason: "missing" });
    expect(await findSession(deps, secondToken)).toMatchObject({
      ok: true,
      session: { id: row!.id, googleAuthAt: clock.now() },
    });
    expect(setCookies(again).get("jobkit_session")).toMatch(
      new RegExp(`Max-Age=${(20 * DAY) / 1000}(;|$)`),
    );
  });

  it("replaces a session the browser holds that cannot be renewed, instead of leaving it behind", async () => {
    const paired = await issueSession(deps, { kind: "paired", label: "phone" });

    const response = await signIn({ sessionToken: paired.token });

    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(cookieValue(response, "jobkit_session")!));
  });

  it("returns to a remembered page, and only to one of this app's own paths", async () => {
    expect((await signIn({ next: "/devices" })).headers.get("location")).toBe(`${ORIGIN}/devices`);
    for (const next of [
      "//evil",
      "//evil.example/x",
      "https://evil.example",
      "/\\evil.example",
      "jobs",
    ]) {
      expect((await signIn({ next })).headers.get("location")).toBe(`${ORIGIN}/jobs`);
    }
  });
});
