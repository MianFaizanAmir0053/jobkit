import { describe, expect, it } from "vitest";

import { checkBuildRoutes } from "./checkBuild";

const production = {
  "/(app)/jobs/page": "/jobs",
  "/api/auth/google/callback/route": "/api/auth/google/callback",
  "/login/page": "/login",
};
const withTestRoute = {
  ...production,
  "/api/test/signin/route": "/api/test/signin",
  "/(app)/test/data/page": "/test/data",
};

describe("checkBuildRoutes", () => {
  it("passes a build without test-only routes", () => {
    expect(checkBuildRoutes(production)).toEqual({ ok: true });
  });

  it("fails every build that contains a test-only route, since only the dev server may have them", () => {
    expect(checkBuildRoutes(withTestRoute)).toEqual({
      ok: false,
      routes: ["/api/test/signin", "/test/data"],
    });
  });
});
