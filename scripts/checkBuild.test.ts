import { describe, expect, it } from "vitest";

import { checkBuildRoutes } from "./checkBuild";

const production = {
  "/(app)/jobs/page": "/jobs",
  "/api/auth/google/callback/route": "/api/auth/google/callback",
  "/login/page": "/login",
};
const withTestRoute = { ...production, "/api/test/signin/route": "/api/test/signin" };

describe("checkBuildRoutes", () => {
  it("passes a build without test-only routes", () => {
    expect(checkBuildRoutes(production, undefined)).toEqual({ ok: true });
    expect(checkBuildRoutes(production, "production")).toEqual({ ok: true });
  });

  it("fails any build outside JOBKIT_ENV=test that contains a test-only route", () => {
    for (const env of [undefined, "production", "development"]) {
      expect(checkBuildRoutes(withTestRoute, env)).toEqual({
        ok: false,
        routes: ["/api/test/signin"],
      });
    }
  });

  it("lets a test build contain them", () => {
    expect(checkBuildRoutes(withTestRoute, "test")).toEqual({ ok: true });
  });
});
