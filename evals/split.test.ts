import { describe, expect, it } from "vitest";

import { assignSplits, type Split, TEST_SIZE } from "./split";

/* The split: evals AC3's first clause. */

const ids = (count: number, prefix = "2026-03-01") =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i.toString(16).padStart(8, "0")}`);

/** Every case given is in the archive and ready. */
const ready = (cases: readonly string[], assigned: Record<string, Split> = {}) =>
  assignSplits({ ready: cases, present: cases, assigned }).splits;

describe("assignSplits", () => {
  it("puts ten cases in test and the rest in dev, the same for the same IDs in any order", () => {
    const cases = ids(25);

    const first = ready(cases);

    expect(Object.values(first).filter((split) => split === "test")).toHaveLength(TEST_SIZE);
    expect(Object.values(first).filter((split) => split === "dev")).toHaveLength(15);
    expect(ready([...cases].reverse())).toEqual(first);
  });

  it("never moves a case once assigned, and fills test before dev as cases arrive", () => {
    const early = ready(ids(4));
    expect(Object.values(early)).toEqual(["test", "test", "test", "test"]);

    const later = ready([...ids(4), ...ids(20, "2026-04-01")], early);

    for (const [id, split] of Object.entries(early)) expect(later[id]).toBe(split);
    expect(Object.values(later).filter((split) => split === "test")).toHaveLength(TEST_SIZE);
  });

  it("keeps an assignment for a case no longer in the archive", () => {
    expect(ready([], { "2026-01-01-00000000": "dev" })).toEqual({ "2026-01-01-00000000": "dev" });
  });

  it("frees a test place only for a case gone or left out, never for one merely not ready", () => {
    const first = ready(ids(10));
    const [gone, unready] = ids(10) as [string, string];
    const fresh = ids(5, "2026-04-01");

    const { splits } = assignSplits({
      ready: [...ids(10).slice(2), ...fresh],
      present: [unready, ...ids(10).slice(2), ...fresh],
      assigned: first,
    });

    expect(splits[gone]).toBe("test");
    expect(splits[unready]).toBe("test");
    expect(fresh.filter((id) => splits[id] === "test")).toHaveLength(1);
  });

  it("gives the cases of one application one split, in test only when all of them fit", () => {
    const nine = Object.fromEntries(ids(9).map((id) => [id, "test" as const]));
    const [first, resend, other] = ids(3, "2026-05-01") as [string, string, string];
    const groupOf = (id: string) => (id === first || id === resend ? "one application" : id);

    const { splits } = assignSplits({
      ready: [...ids(9), first, resend, other],
      present: [...ids(9), first, resend, other],
      assigned: nine,
      groupOf,
    });

    expect([splits[first], splits[resend], splits[other]]).toEqual(["dev", "dev", "test"]);
  });

  it("puts a new case in the split its application has, from any case of it still there", () => {
    const [sent, resend, reply] = ids(3, "2026-06-01") as [string, string, string];

    const { splits } = assignSplits({
      ready: [resend],
      // The first email is there but not ready: its split still holds for its application.
      present: [sent, resend],
      assigned: { [sent]: "dev" },
      groupOf: () => "one application",
    });
    expect(splits[resend]).toBe("dev");

    const { splits: inTest } = assignSplits({
      ready: [reply],
      present: [sent, reply],
      assigned: { [sent]: "test" },
      groupOf: () => "one application",
    });
    expect(inTest[reply]).toBe("test");
  });

  it("holds back a new case of an application in a full test set, rather than overfill it", () => {
    const ten = Object.fromEntries(ids(10).map((id) => [id, "test" as const]));
    const [resend] = ids(1, "2026-07-01") as [string];
    const groupOf = (id: string) => (id === resend || id === ids(10)[0] ? "one application" : id);

    const outcome = assignSplits({
      ready: [...ids(10), resend],
      present: [...ids(10), resend],
      assigned: ten,
      groupOf,
    });

    expect(outcome.held).toEqual([resend]);
    expect(Object.hasOwn(outcome.splits, resend)).toBe(false);
  });

  it("never puts in test a case whose labels cannot be blind", () => {
    const [live, mail] = ["live-2026-10-06-00000001", "2026-03-01-00000001"];

    const { splits } = assignSplits({
      ready: [live, mail],
      present: [live, mail],
      assigned: {},
      blind: (id) => !id.startsWith("live-"),
    });

    expect(splits).toEqual({ [live]: "dev", [mail]: "test" });
  });
});
