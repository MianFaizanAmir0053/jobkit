import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkBuildRoutes, LOCAL_ONLY_PREFIXES, TEST_ONLY_PREFIXES } from "./checkBuild";

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

  it("fails every build that contains a local-only storage route, which only a local dev server may have", () => {
    expect(
      checkBuildRoutes({
        ...production,
        "/api/dev/storage/upload/[token]/route": "/api/dev/storage/upload/[token]",
      }),
    ).toEqual({ ok: false, routes: ["/api/dev/storage/upload/[token]"] });
  });
});

describe("the test-only files", () => {
  it("all sit under a prefix the check looks for, so a misplaced one cannot slip through", () => {
    const appDir = join(process.cwd(), "src", "app");
    const files = readdirSync(appDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.testonly\.tsx?$/.test(file),
    );

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // Route groups such as (app) are not part of the URL.
      // readdirSync joins with the platform's separator: a backslash on Windows.
      const segments = dirname(file)
        .split(/[\\/]/)
        .filter((s) => !/^\(.*\)$/.test(s));
      const url = `/${segments.join("/")}/`;
      expect(
        TEST_ONLY_PREFIXES.some((prefix) => url.startsWith(prefix)),
        file,
      ).toBe(true);
    }
  });
});

describe("the local-only files", () => {
  it("all sit under a prefix the check looks for", () => {
    const appDir = join(process.cwd(), "src", "app");
    const files = readdirSync(appDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.localonly\.ts$/.test(file),
    );

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const segments = dirname(file)
        .split(/[\\/]/)
        .filter((s) => !/^\(.*\)$/.test(s));
      const url = `/${segments.join("/")}/`;
      expect(
        LOCAL_ONLY_PREFIXES.some((prefix) => url.startsWith(prefix)),
        file,
      ).toBe(true);
    }
  });
});
