import { describe, expect, it } from "vitest";

import { testRoutesAllowed } from "./testOnly";

describe("testRoutesAllowed", () => {
  it("allows the test routes only in the dev server with the in-memory test container", () => {
    expect(testRoutesAllowed({ NODE_ENV: "development" }, "test")).toBe(true);
  });

  it("refuses any production server, anything on Vercel, and any other container", () => {
    expect(testRoutesAllowed({ NODE_ENV: "production" }, "test")).toBe(false);
    expect(testRoutesAllowed({ NODE_ENV: "development", VERCEL: "1" }, "test")).toBe(false);
    expect(testRoutesAllowed({ NODE_ENV: "development" }, "development")).toBe(false);
    expect(testRoutesAllowed({ NODE_ENV: "development" }, "production")).toBe(false);
  });
});
