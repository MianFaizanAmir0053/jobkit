import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { keyFrom, openSealed, seal } from "./seal";

/* Secrets kept at rest, such as the Gmail refresh token (decisions A20). */

const key = randomBytes(32);

describe("seal", () => {
  it("keeps a secret that only its key opens, and seals it differently each time", () => {
    const sealed = seal("refresh-token-value", key);

    expect(sealed).not.toContain("refresh-token-value");
    expect(seal("refresh-token-value", key)).not.toBe(sealed);
    expect(openSealed(sealed, key)).toBe("refresh-token-value");
    expect(() => openSealed(sealed, randomBytes(32))).toThrow();
  });

  it("refuses a sealed value that was altered", () => {
    const sealed = Buffer.from(seal("refresh-token-value", key), "base64");
    sealed[sealed.length - 1]! ^= 1;

    expect(() => openSealed(sealed.toString("base64"), key)).toThrow();
  });
});

describe("keyFrom", () => {
  it("takes 32 bytes written as base64, and nothing else", () => {
    expect(keyFrom(key.toString("base64"))?.equals(key)).toBe(true);
    expect(keyFrom(undefined)).toBeNull();
    expect(keyFrom("")).toBeNull();
    expect(keyFrom(randomBytes(16).toString("base64"))).toBeNull();
    expect(keyFrom("not base64 at all!")).toBeNull();
  });
});
