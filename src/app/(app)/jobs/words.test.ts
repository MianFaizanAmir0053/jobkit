import { describe, expect, it } from "vitest";

import { placeOfFlag } from "./words";

/* Where a flag on what extract read points, in the owner's words. */

describe("placeOfFlag", () => {
  it("names the role, the entry and the contact a path points at", () => {
    expect(placeOfFlag("roles[1].requirements[2].id")).toBe("Role 2, requirement 3");
    expect(placeOfFlag("roles[0].screening_questions[0].id")).toBe("Role 1, question 1");
    expect(placeOfFlag("roles[0].route.address")).toBe("Role 1, contact");
    expect(placeOfFlag("roles[2].id")).toBe("Role 3");
  });

  it("names nothing for a flag on the whole record", () => {
    expect(placeOfFlag("roles")).toBe("");
    expect(placeOfFlag("company.name")).toBe("");
  });
});
