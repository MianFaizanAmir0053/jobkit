import { describe, expect, it } from "vitest";

import { testRoutesAllowed } from "./testOnly";

describe("testRoutesAllowed", () => {
  it("allows the test routes only in the dev server with the in-memory test container", () => {
    expect(testRoutesAllowed({ NODE_ENV: "development" }, "test")).toBe(true);
    // `vercel env pull` writes these into a local file; that is still the laptop.
    expect(
      testRoutesAllowed(
        { NODE_ENV: "development", VERCEL: "1", VERCEL_ENV: "development" },
        "test",
      ),
    ).toBe(true);
  });

  it("refuses any server not started by next dev, any Vercel deployment, and any other container", () => {
    expect(testRoutesAllowed({ NODE_ENV: "production" }, "test")).toBe(false);
    expect(testRoutesAllowed({ NODE_ENV: "test" }, "test")).toBe(false);
    expect(testRoutesAllowed({}, "test")).toBe(false);
    expect(
      testRoutesAllowed({ NODE_ENV: "development", VERCEL: "1", VERCEL_ENV: "preview" }, "test"),
    ).toBe(false);
    expect(testRoutesAllowed({ NODE_ENV: "development" }, "development")).toBe(false);
    expect(testRoutesAllowed({ NODE_ENV: "development" }, "production")).toBe(false);
  });
});
