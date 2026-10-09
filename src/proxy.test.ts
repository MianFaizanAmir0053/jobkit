import {
  getRedirectUrl,
  unstable_doesMiddlewareMatch as doesProxyMatch,
} from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, proxy } from "./proxy";

const ORIGIN = "http://localhost:3000";

describe("which requests the proxy sees", () => {
  it("runs on the app's pages, including any whose name merely starts like an exempt one", () => {
    for (const url of [
      "/",
      "/jobs",
      "/jobs/123",
      "/devices",
      "/baseline",
      "/pairing-history",
      "/logins",
    ]) {
      expect(doesProxyMatch({ config, url })).toBe(true);
    }
  });

  it("leaves out sign-in, pairing, the API, Next's own paths and every static file", () => {
    for (const url of [
      "/login",
      "/pair",
      "/api/auth/google/start",
      "/api/pair/redeem",
      "/api/cron/daily",
      "/_next/static/chunks/main.js",
      "/__nextjs_original-stack-frame",
      "/manifest.webmanifest",
      "/sw.js",
      "/icons/icon-192.png",
      "/favicon.ico",
    ]) {
      expect(doesProxyMatch({ config, url })).toBe(false);
    }
  });
});

describe("proxy", () => {
  it("sends a page request that carries no session cookie to /login", () => {
    const response = proxy(new NextRequest(`${ORIGIN}/jobs`));

    expect(getRedirectUrl(response)).toBe(`${ORIGIN}/login`);
  });

  it("lets a request with a session cookie through, leaving the real check to requireSession", () => {
    const response = proxy(
      new NextRequest(`${ORIGIN}/jobs`, { headers: { cookie: "jobkit_session=anything" } }),
    );

    expect(getRedirectUrl(response)).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
