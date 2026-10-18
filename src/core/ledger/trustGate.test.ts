import { describe, expect, it } from "vitest";

import { type KitOutcome, trustGateState } from "./trustGate";

const clean: KitOutcome = { kind: "email", skipped: false, factualEdit: false };
const edited: KitOutcome = { kind: "email", skipped: false, factualEdit: true };
const times = (n: number, outcome: KitOutcome): KitOutcome[] =>
  Array.from({ length: n }, () => outcome);

describe("trustGateState", () => {
  it("starts locked, needing ten clean email outcomes", () => {
    expect(trustGateState([])).toEqual({ unlocked: false, cleanStreak: 0, needed: 10 });
  });

  it("unlocks after ten clean outcomes in a row, and not before", () => {
    expect(trustGateState(times(9, clean))).toEqual({
      unlocked: false,
      cleanStreak: 9,
      needed: 10,
    });
    expect(trustGateState(times(10, clean))).toEqual({
      unlocked: true,
      cleanStreak: 10,
      needed: 10,
    });
  });

  it("starts the count again after a factual edit before it unlocks", () => {
    const outcomes = [...times(6, clean), edited, ...times(9, clean)];

    expect(trustGateState(outcomes)).toEqual({ unlocked: false, cleanStreak: 9, needed: 10 });
    expect(trustGateState([...outcomes, clean])).toMatchObject({ unlocked: true });
  });

  it("locks again on a factual edit after unlocking, and five clean outcomes unlock it", () => {
    const relocked = [...times(12, clean), edited];

    expect(trustGateState(relocked)).toEqual({ unlocked: false, cleanStreak: 0, needed: 5 });
    expect(trustGateState([...relocked, ...times(4, clean)])).toEqual({
      unlocked: false,
      cleanStreak: 4,
      needed: 5,
    });
    expect(trustGateState([...relocked, ...times(5, clean)])).toEqual({
      unlocked: true,
      cleanStreak: 5,
      needed: 5,
    });
  });

  it("ignores skipped jobs and form and message kits", () => {
    const noise: KitOutcome[] = [
      { kind: "form", skipped: false, factualEdit: true },
      { kind: "message", skipped: false, factualEdit: true },
      { kind: "email", skipped: true, factualEdit: true },
    ];

    expect(trustGateState(times(10, clean).flatMap((outcome) => [outcome, ...noise]))).toEqual({
      unlocked: true,
      cleanStreak: 10,
      needed: 10,
    });
  });
});
