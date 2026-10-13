import { describe, expect, it } from "vitest";

import { assignSplits, TEST_SIZE } from "./split";

/* The split: evals AC3's first clause. */

const ids = (count: number, prefix = "2026-03-01") =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i.toString(16).padStart(8, "0")}`);

describe("assignSplits", () => {
  it("puts ten cases in test and the rest in dev, the same for the same IDs in any order", () => {
    const cases = ids(25);

    const first = assignSplits(cases, {});
    const again = assignSplits([...cases].reverse(), {});

    expect(Object.values(first).filter((split) => split === "test")).toHaveLength(TEST_SIZE);
    expect(Object.values(first).filter((split) => split === "dev")).toHaveLength(15);
    expect(again).toEqual(first);
  });

  it("never moves a case once assigned, and fills test before dev as cases arrive", () => {
    const early = assignSplits(ids(4), {});
    expect(Object.values(early)).toEqual(["test", "test", "test", "test"]);

    const later = assignSplits([...ids(4), ...ids(20, "2026-04-01")], early);

    for (const [id, split] of Object.entries(early)) expect(later[id]).toBe(split);
    expect(Object.values(later).filter((split) => split === "test")).toHaveLength(TEST_SIZE);
  });

  it("keeps an assignment for a case no longer in the archive", () => {
    expect(assignSplits([], { "2026-01-01-00000000": "dev" })).toEqual({
      "2026-01-01-00000000": "dev",
    });
  });
});
