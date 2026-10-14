import { describe, expect, it } from "vitest";

import { devOriginsFor } from "./devOrigins";

/* The hostnames the dev server lets request its dev assets, for a tunnel to the phone. */

describe("devOriginsFor", () => {
  it("allows a tunnel's own hostname, and no other", () => {
    expect(devOriginsFor("https://quiet-river-1234.ngrok-free.app")).toEqual([
      "quiet-river-1234.ngrok-free.app",
    ]);
  });

  it("adds nothing for the laptop itself, which the dev server already allows", () => {
    expect(devOriginsFor("http://localhost:3000")).toEqual([]);
    expect(devOriginsFor("http://127.0.0.1:3000")).toEqual([]);
    expect(devOriginsFor(undefined)).toEqual([]);
    expect(devOriginsFor("not an origin")).toEqual([]);
  });
});
