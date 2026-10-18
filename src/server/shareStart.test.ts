import { describe, expect, it } from "vitest";

import { ownerSent } from "./shareStart";

/* Which New job requests a share starts from with no tap (intake spec, "Inputs"). */

const endToEnd = { JOBKIT_ENV: "test", NODE_ENV: "development" };

describe("ownerSent", () => {
  it("takes the owner's own doing, the share sheet or the address bar, anywhere", () => {
    for (const env of [{ JOBKIT_ENV: "production" }, { JOBKIT_ENV: "development" }, endToEnd]) {
      expect(ownerSent("none", env)).toBe(true);
    }
  });

  it("takes jobkit's own page only in the end-to-end tests' dev server, which post a share from it", () => {
    expect(ownerSent("same-origin", endToEnd)).toBe(true);
    for (const env of [
      { JOBKIT_ENV: "production", NODE_ENV: "production" },
      { JOBKIT_ENV: "development", NODE_ENV: "development" },
      // A wrong JOBKIT_ENV in a build, or on a Vercel deployment, opens nothing.
      { JOBKIT_ENV: "test", NODE_ENV: "production" },
      { ...endToEnd, VERCEL: "1", VERCEL_ENV: "preview" },
    ]) {
      expect(ownerSent("same-origin", env)).toBe(false);
    }
  });

  it("takes nothing else, nor a request that says nothing", () => {
    for (const site of ["same-site", "cross-site", "", null]) {
      expect(ownerSent(site, endToEnd)).toBe(false);
    }
  });
});
