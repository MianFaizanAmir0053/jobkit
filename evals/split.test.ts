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

  it("counts only the test cases still given, so one deleted or left out frees its place", () => {
    const first = assignSplits(ids(10), {});
    const gone = ids(10).slice(0, 3);
    const stay = ids(10).slice(3);
    const fresh = ids(5, "2026-04-01");

    const later = assignSplits([...stay, ...fresh], first);

    expect([...stay, ...fresh].filter((id) => later[id] === "test")).toHaveLength(TEST_SIZE);
    for (const id of gone) expect(later[id]).toBe("test");
  });

  it("gives the cases of one application one split, in test only when all of them fit", () => {
    const nine = Object.fromEntries(ids(9).map((id) => [id, "test" as const]));
    const [first, resend, other] = ids(3, "2026-05-01") as [string, string, string];
    const groupOf = (id: string) => (id === first || id === resend ? "one application" : id);

    const result = assignSplits([...ids(9), first, resend, other], nine, groupOf);

    expect([result[first], result[resend], result[other]]).toEqual(["dev", "dev", "test"]);
  });

  it("puts a new case in the split its application already has", () => {
    const [sent, resend] = ids(2, "2026-06-01") as [string, string];

    expect(assignSplits([sent, resend], { [sent]: "dev" }, () => "one application")).toEqual({
      [sent]: "dev",
      [resend]: "dev",
    });
  });
});
