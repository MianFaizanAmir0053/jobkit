import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGmailSender, MAX_MESSAGE_BYTES } from "./gmail";

/* Sending one email from the owner's Gmail through the Gmail API: decisions A20. */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const MESSAGE = "MIME-Version: 1.0\r\nTo: jobs@example.com\r\n\r\nHello\r\n";

const sender = () =>
  createGmailSender({
    clientId: "client-123",
    clientSecret: "fixture-client-secret",
    redirectUri: "http://localhost:3000/api/auth/google/callback",
    refreshToken: "fixture-refresh-token",
  });

let requests: { url: string; headers: Headers; body: string }[];

function google(answer: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.text() });
    return answer(request.url);
  });
}

const tokens = () =>
  Response.json({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3599 });

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGmailSender", () => {
  it("refreshes the access token, then uploads the message with it", async () => {
    google((url) => (url === TOKEN_URL ? tokens() : Response.json({ id: "m1", threadId: "t1" })));

    expect(await sender().send(MESSAGE)).toEqual({ ok: true, messageId: "m1", threadId: "t1" });

    expect(requests.map((request) => request.url)).toEqual([TOKEN_URL, UPLOAD_URL]);
    const refresh = new URLSearchParams(requests[0]!.body);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("fixture-refresh-token");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer fixture-access-token");
    expect(requests[1]!.headers.get("content-type")).toBe("message/rfc822");
    expect(requests[1]!.body).toBe(MESSAGE);
  });

  it("says Gmail must be connected again when Google refuses the refresh token or the send", async () => {
    google(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await sender().send(MESSAGE)).toMatchObject({ ok: false, reason: "unauthorised" });

    google((url) =>
      url === TOKEN_URL ? tokens() : new Response("insufficient scope", { status: 403 }),
    );
    expect(await sender().send(MESSAGE)).toMatchObject({ ok: false, reason: "unauthorised" });
  });

  it("fails, and says why, when Gmail refuses the message or the token cannot be refreshed", async () => {
    google((url) => (url === TOKEN_URL ? tokens() : new Response("bad request", { status: 400 })));
    expect(await sender().send(MESSAGE)).toEqual({
      ok: false,
      reason: "failed",
      message: "Gmail answered 400: bad request",
    });

    // Nothing was sent: the token's own request never reached Google.
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await sender().send(MESSAGE)).toMatchObject({ ok: false, reason: "failed" });
  });

  it("says the email may have gone when the connection drops while Gmail has it", async () => {
    google((url) => {
      if (url === TOKEN_URL) return tokens();
      throw new TypeError("fetch failed");
    });

    expect(await sender().send(MESSAGE)).toEqual({
      ok: false,
      reason: "unknown",
      message: "fetch failed",
    });
  });

  it("says the email may have gone when Google's servers err, since they may have sent it", async () => {
    for (const status of [500, 502, 503, 504]) {
      google((url) => (url === TOKEN_URL ? tokens() : new Response("backend error", { status })));
      expect(await sender().send(MESSAGE)).toEqual({
        ok: false,
        reason: "unknown",
        message: `Gmail answered ${status}: backend error`,
      });
    }
  });

  it("says Gmail's sending limit was reached, not to connect again, on a rate or quota answer", async () => {
    const limited = {
      error: {
        code: 403,
        message: "User-rate limit exceeded",
        errors: [{ reason: "userRateLimitExceeded" }],
        status: "PERMISSION_DENIED",
      },
    };
    google((url) => (url === TOKEN_URL ? tokens() : Response.json(limited, { status: 403 })));
    expect(await sender().send(MESSAGE)).toMatchObject({
      ok: false,
      reason: "failed",
      message: expect.stringMatching(/limit/),
    });

    google((url) =>
      url === TOKEN_URL ? tokens() : new Response("Too many requests", { status: 429 }),
    );
    expect(await sender().send(MESSAGE)).toMatchObject({ ok: false, reason: "failed" });
  });

  it("gives up on a token refresh that hangs, having sent nothing", async () => {
    vi.useFakeTimers();
    try {
      google((url) => (url === TOKEN_URL ? new Promise<Response>(() => {}) : tokens()));
      const sending = sender().send(MESSAGE);

      await vi.advanceTimersByTimeAsync(15_000);

      expect(await sending).toMatchObject({ ok: false, reason: "failed" });
      expect(requests.map((request) => request.url)).toEqual([TOKEN_URL]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a message larger than Gmail takes, without sending it", async () => {
    google((url) => (url === TOKEN_URL ? tokens() : Response.json({ id: "m1", threadId: "t1" })));

    expect(await sender().send("x".repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(requests).toEqual([]);
  });
});
