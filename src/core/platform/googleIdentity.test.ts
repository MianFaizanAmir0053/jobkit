import { describe, expect, it } from "vitest";

import { identityFromIdToken } from "./googleIdentity";

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const NOW = new Date("2026-10-06T09:00:00Z");
const nowSeconds = NOW.getTime() / 1000;

const claims = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: nowSeconds + 3600,
  iat: nowSeconds,
  sub: "1001",
  email: "owner@example.com",
  email_verified: true,
};

const read = (c: unknown) => identityFromIdToken(c, { clientId: CLIENT_ID, now: NOW });

describe("identityFromIdToken", () => {
  it("reads the sub, email and email_verified claims of a token issued to this app", () => {
    expect(read(claims)).toEqual({
      ok: true,
      identity: { sub: "1001", email: "owner@example.com", emailVerified: true },
    });
  });

  it("accepts both issuer spellings Google documents", () => {
    expect(read({ ...claims, iss: "accounts.google.com" })).toMatchObject({ ok: true });
  });

  it("passes an unverified email through, for the owner check to refuse", () => {
    expect(read({ ...claims, email_verified: false })).toMatchObject({
      ok: true,
      identity: { emailVerified: false },
    });
  });

  it("refuses a token from another issuer", () => {
    expect(read({ ...claims, iss: "https://evil.example" })).toEqual({
      ok: false,
      reason: "wrong-issuer",
    });
  });

  it("refuses a token issued to another app", () => {
    expect(read({ ...claims, aud: "someone-else" })).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
  });

  it("refuses an expired token", () => {
    expect(read({ ...claims, exp: nowSeconds })).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token missing the email claims, rather than guessing", () => {
    const withoutVerified: Record<string, unknown> = { ...claims };
    delete withoutVerified.email_verified;

    expect(read(withoutVerified)).toEqual({ ok: false, reason: "malformed" });
    expect(read({ ...claims, sub: "" })).toEqual({ ok: false, reason: "malformed" });
    expect(read(null)).toEqual({ ok: false, reason: "malformed" });
  });
});
