import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { findSession, issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import {
  approve,
  createToken,
  redeem,
  REDEEM_FAILURE,
  reject,
  status,
  waiting,
  type PairingDeps,
} from "./pairing";

const ORIGIN = "http://localhost:3000";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
let clock: FakeClock;
let deps: PairingDeps;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.sessions");
  clock = fakeClock();
  deps = { db, clock, random: cryptoRandom, config };
});

function request(
  path: string,
  opts: { body?: unknown; rawBody?: string; cookie?: string; origin?: string | null } = {},
): NextRequest {
  const headers: Record<string, string> = { "user-agent": ANDROID_CHROME };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = `jobkit_session=${opts.cookie}`;
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: hasBody ? "POST" : "GET",
    headers,
    body: opts.rawBody ?? (hasBody ? JSON.stringify(opts.body) : undefined),
  });
}

async function laptop(): Promise<string> {
  return (await issueSession(deps, { kind: "google", label: "Windows · Chrome" })).token;
}

async function newToken(laptopCookie: string): Promise<string> {
  const response = await createToken(
    request("/api/pair/tokens", { body: {}, cookie: laptopCookie }),
    deps,
  );
  const { url } = (await response.json()) as { url: string };
  return new URL(url).hash.slice("#t=".length);
}

async function redeemed(): Promise<{
  laptopCookie: string;
  phoneCookie: string;
  code: string;
  pairingId: string;
}> {
  const laptopCookie = await laptop();
  const response = await redeem(
    request("/api/pair/redeem", { body: { token: await newToken(laptopCookie) } }),
    deps,
  );
  const { code } = (await response.json()) as { code: string };
  const phoneCookie = response.cookies.get("jobkit_session")!.value;
  const list = await waiting(request("/api/pair/waiting", { cookie: laptopCookie }), deps);
  const { phones } = (await list.json()) as { phones: { pairingId: string }[] };
  return { laptopCookie, phoneCookie, code, pairingId: phones[0]!.pairingId };
}

describe("POST /api/pair/tokens", () => {
  it("gives a google session a QR code for /pair#t=<token>, never in a query string", async () => {
    const response = await createToken(
      request("/api/pair/tokens", { body: {}, cookie: await laptop() }),
      deps,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      url: string;
      svg: string;
      expiresAt: string;
      expiresInSeconds: number;
    };
    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/pair`);
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#t=[A-Za-z0-9_-]{43}$/);
    expect(body.svg).toMatch(/^<svg/);
    expect(body.expiresAt).toBe(new Date(clock.now().getTime() + 2 * MINUTE).toISOString());
    expect(body.expiresInSeconds).toBe(120);
  });

  it("sends a google session whose sign-in is over five minutes old back to Google first", async () => {
    const cookie = await laptop();
    clock.advance(5 * MINUTE + 1);

    const response = await createToken(request("/api/pair/tokens", { body: {}, cookie }), deps);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "stale-google-auth" });
  });

  it("refuses a paired session, a missing session and a foreign origin", async () => {
    const phone = (await issueSession(deps, { kind: "paired", label: "phone" })).token;
    await db.exec("update {{schema}}.sessions set approved_at = created_at");

    const asPhone = await createToken(
      request("/api/pair/tokens", { body: {}, cookie: phone }),
      deps,
    );
    const signedOut = await createToken(request("/api/pair/tokens", { body: {} }), deps);
    const foreign = await createToken(
      request("/api/pair/tokens", {
        body: {},
        cookie: await laptop(),
        origin: "https://evil.example",
      }),
      deps,
    );

    expect([asPhone.status, signedOut.status, foreign.status]).toEqual([403, 401, 403]);
    expect((await db.query("select * from {{schema}}.pairing_tokens")).rows).toEqual([]);
  });
});

describe("POST /api/pair/redeem", () => {
  it("redeems a token once: the phone gets a 180-day cookie and its code", async () => {
    const token = await newToken(await laptop());

    const first = await redeem(request("/api/pair/redeem", { body: { token } }), deps);
    const second = await redeem(request("/api/pair/redeem", { body: { token } }), deps);

    expect(first.status).toBe(200);
    expect(((await first.json()) as { code: string }).code).toMatch(/^\d{6}$/);
    const cookie = first.headers.getSetCookie().find((c) => c.startsWith("jobkit_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(new RegExp(`Max-Age=${(180 * DAY) / 1000}(;|$)`));
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: REDEEM_FAILURE });
  });

  it("gives every failure the same message, revealing nothing about which check failed", async () => {
    const laptopCookie = await laptop();
    const expired = await newToken(laptopCookie);
    clock.advance(2 * MINUTE);
    const fresh = await newToken(await laptop());

    const failures = await Promise.all([
      redeem(request("/api/pair/redeem", { body: { token: expired } }), deps),
      redeem(request("/api/pair/redeem", { body: { token: "not-a-token" } }), deps),
      redeem(request("/api/pair/redeem", { body: {} }), deps),
      redeem(request("/api/pair/redeem", { rawBody: "not json" }), deps),
      redeem(
        request("/api/pair/redeem", { body: { token: fresh }, origin: "https://evil.example" }),
        deps,
      ),
      redeem(request("/api/pair/redeem", { body: { token: fresh }, origin: null }), deps),
    ]);

    for (const response of failures) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: REDEEM_FAILURE });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(
      (await redeem(request("/api/pair/redeem", { body: { token: fresh } }), deps)).status,
    ).toBe(200);
  });

  it("answers a database failure, such as a deadlock, with the same message", async () => {
    const token = await newToken(await laptop());
    const failing = {
      ...deps,
      db: {
        ...db,
        tx: async () => {
          throw new Error("deadlock detected");
        },
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await redeem(request("/api/pair/redeem", { body: { token } }), failing);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: REDEEM_FAILURE });
    expect(logged.mock.calls.flat().join(" ")).not.toContain(token);
    logged.mockRestore();
  });

  it("answers a failure while looking up the session the browser holds with the same message", async () => {
    const token = await newToken(await laptop());
    const failing = {
      ...deps,
      db: {
        ...db,
        query: async () => {
          throw new Error("connection lost");
        },
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await redeem(
      request("/api/pair/redeem", { body: { token }, cookie: "some-old-session" }),
      failing,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: REDEEM_FAILURE });
    logged.mockRestore();
  });

  it("leaves a browser signed in with Google alone, and the token usable by the phone", async () => {
    const laptopCookie = await laptop();
    const token = await newToken(laptopCookie);

    const fromLaptop = await redeem(
      request("/api/pair/redeem", { body: { token }, cookie: laptopCookie }),
      deps,
    );
    const fromPhone = await redeem(request("/api/pair/redeem", { body: { token } }), deps);

    expect(fromLaptop.status).toBe(400);
    expect(await findSession(deps, laptopCookie)).toMatchObject({ ok: true });
    expect(fromPhone.status).toBe(200);
  });

  it("replaces a phone session the browser already held", async () => {
    const earlier = await redeemed();

    const again = await redeem(
      request("/api/pair/redeem", {
        body: { token: await newToken(earlier.laptopCookie) },
        cookie: earlier.phoneCookie,
      }),
      deps,
    );

    expect(again.status).toBe(200);
    expect(await findSession(deps, earlier.phoneCookie)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("GET /api/pair/status", () => {
  it("follows the phone from waiting to approved, and says gone after Reject", async () => {
    const one = await redeemed();
    const two = await redeemed();
    const state = async (cookie: string) =>
      (
        (await (await status(request("/api/pair/status", { cookie }), deps)).json()) as {
          state: string;
        }
      ).state;

    expect(await state(one.phoneCookie)).toBe("waiting");
    await approve(
      request("/api/pair/approve", {
        body: { pairingId: one.pairingId, code: one.code },
        cookie: one.laptopCookie,
      }),
      deps,
    );
    await reject(
      request("/api/pair/reject", { body: { pairingId: two.pairingId }, cookie: two.laptopCookie }),
      deps,
    );

    expect(await state(one.phoneCookie)).toBe("approved");
    expect(await state(two.phoneCookie)).toBe("gone");
  });
});

describe("GET /api/pair/waiting", () => {
  it("shows a google session the phones waiting for it", async () => {
    const { laptopCookie, pairingId } = await redeemed();

    const response = await waiting(request("/api/pair/waiting", { cookie: laptopCookie }), deps);

    expect(await response.json()).toEqual({
      phones: [{ pairingId, label: "Android · Chrome", redeemedAt: clock.now().toISOString() }],
    });
  });

  it("refuses a phone, waiting or approved, and a signed-out browser", async () => {
    const { laptopCookie, phoneCookie, code, pairingId } = await redeemed();
    const waitingPhone = await waiting(request("/api/pair/waiting", { cookie: phoneCookie }), deps);
    await approve(
      request("/api/pair/approve", { body: { pairingId, code }, cookie: laptopCookie }),
      deps,
    );
    const approvedPhone = await waiting(
      request("/api/pair/waiting", { cookie: phoneCookie }),
      deps,
    );

    expect(waitingPhone.status).toBe(401);
    expect(approvedPhone.status).toBe(403);
    expect((await waiting(request("/api/pair/waiting"), deps)).status).toBe(401);
  });
});

describe("POST /api/pair/approve", () => {
  it("approves with the phone's code, and counts a wrong one", async () => {
    const { laptopCookie, phoneCookie, code, pairingId } = await redeemed();
    const send = (typed: string) =>
      approve(
        request("/api/pair/approve", { body: { pairingId, code: typed }, cookie: laptopCookie }),
        deps,
      );

    const wrongOnce = await send(code === "000000" ? "111111" : "000000");
    const right = await send(code);

    expect(wrongOnce.status).toBe(400);
    expect(await wrongOnce.json()).toEqual({ error: "wrong-code", attemptsLeft: 4 });
    expect(right.status).toBe(200);
    expect(await findSession(deps, phoneCookie)).toMatchObject({ ok: true });
  });

  it("refuses a foreign origin and a paired session, and asks for a fresh Google sign-in", async () => {
    const { laptopCookie, code, pairingId } = await redeemed();
    const otherPhone = (await issueSession(deps, { kind: "paired", label: "x" })).token;
    await db.query("update {{schema}}.sessions set approved_at = created_at where label = 'x'");
    const body = { pairingId, code };

    const foreign = await approve(
      request("/api/pair/approve", { body, cookie: laptopCookie, origin: "https://evil.example" }),
      deps,
    );
    const asPhone = await approve(request("/api/pair/approve", { body, cookie: otherPhone }), deps);
    clock.advance(4 * MINUTE + 59_000);
    const stillFresh = await approve(
      request("/api/pair/approve", { body: { pairingId, code: "999999x" }, cookie: laptopCookie }),
      deps,
    );
    clock.advance(2_000);
    const stale = await approve(request("/api/pair/approve", { body, cookie: laptopCookie }), deps);

    expect(foreign.status).toBe(403);
    expect(asPhone.status).toBe(403);
    expect(await asPhone.json()).toEqual({ error: "wrong-kind" });
    expect(stillFresh.status).toBe(400);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "stale-google-auth" });
  });

  it("says gone once the phone's session has been deleted", async () => {
    const { laptopCookie, code, pairingId } = await redeemed();
    await reject(request("/api/pair/reject", { body: { pairingId }, cookie: laptopCookie }), deps);

    const response = await approve(
      request("/api/pair/approve", { body: { pairingId, code }, cookie: laptopCookie }),
      deps,
    );

    expect(response.status).toBe(410);
  });

  it("rejects a malformed body", async () => {
    const { laptopCookie } = await redeemed();

    const response = await approve(
      request("/api/pair/approve", { body: { pairingId: "x", code: "1" }, cookie: laptopCookie }),
      deps,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad-request" });
  });
});

describe("POST /api/pair/reject", () => {
  it("deletes the waiting phone's session, for its approver only", async () => {
    const { laptopCookie, phoneCookie, pairingId } = await redeemed();
    const otherLaptop = await laptop();

    const byOther = await reject(
      request("/api/pair/reject", { body: { pairingId }, cookie: otherLaptop }),
      deps,
    );
    const byApprover = await reject(
      request("/api/pair/reject", { body: { pairingId }, cookie: laptopCookie }),
      deps,
    );

    expect(byOther.status).toBe(410);
    expect(byApprover.status).toBe(204);
    expect(await findSession(deps, phoneCookie)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a foreign origin", async () => {
    const { laptopCookie, phoneCookie, pairingId } = await redeemed();

    const response = await reject(
      request("/api/pair/reject", {
        body: { pairingId },
        cookie: laptopCookie,
        origin: "https://evil.example",
      }),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await findSession(deps, phoneCookie)).toEqual({ ok: false, reason: "unapproved" });
  });
});
