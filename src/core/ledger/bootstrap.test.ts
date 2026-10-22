import { describe, expect, it } from "vitest";

import { medianInterval, ratioInterval } from "./bootstrap";
import { median } from "./stats";

/*
 * The bootstrap intervals of the Stats page's comparison (ledger spec,
 * "Timing and stats"; ledger AC5): drawn from a fixed seed, so the page
 * shows the same interval for the same runs.
 */

/** Total times in minutes, as a route's runs might take: jobkit's, and the old way's. */
const TOOL = [9, 11, 12, 12, 14, 15, 17, 18, 22, 31];
const MANUAL = [28, 33, 35, 38, 41, 44, 46, 51, 57, 70];

describe("the bootstrap intervals", () => {
  it("are the same for the same runs each time they are drawn, whatever was drawn before", () => {
    const first = [medianInterval(TOOL), ratioInterval(MANUAL, TOOL)];
    medianInterval(MANUAL);
    ratioInterval(TOOL, MANUAL);

    expect(first[0]).not.toBeNull();
    expect([medianInterval(TOOL), ratioInterval(MANUAL, TOOL)]).toEqual(first);
  });

  it("are the same for the same runs in another order, as the database may return them", () => {
    const reversed = (values: readonly number[]) => [...values].reverse();

    expect(medianInterval(reversed(TOOL))).toEqual(medianInterval(TOOL));
    expect(ratioInterval(reversed(MANUAL), reversed(TOOL))).toEqual(ratioInterval(MANUAL, TOOL));
  });
});

describe("medianInterval", () => {
  it("brackets the runs' median", () => {
    const interval = medianInterval(TOOL)!;

    expect(interval.low).toBeLessThanOrEqual(median(TOOL)!);
    expect(interval.high).toBeGreaterThanOrEqual(median(TOOL)!);
    expect(interval.low).toBeLessThan(interval.high);
  });

  it("is the one time of a single run, and null for no runs", () => {
    expect(medianInterval([25])).toEqual({ low: 25, high: 25 });
    expect(medianInterval([])).toBeNull();
  });
});

describe("ratioInterval", () => {
  it("brackets the ratio of the two medians", () => {
    const ratio = median(MANUAL)! / median(TOOL)!;
    const interval = ratioInterval(MANUAL, TOOL)!;

    expect(interval.low).toBeLessThanOrEqual(ratio);
    expect(interval.high).toBeGreaterThanOrEqual(ratio);
    expect(interval.low).toBeGreaterThan(1);
  });

  it("brackets 1 for two arms that ran alike, and is 1 for one run of the same time in each", () => {
    const interval = ratioInterval([...TOOL], TOOL)!;

    expect(interval.low).toBeLessThanOrEqual(1);
    expect(interval.high).toBeGreaterThanOrEqual(1);
    expect(ratioInterval([20], [20])).toEqual({ low: 1, high: 1 });
  });

  it("is null when either arm has no runs, or a resample of the bottom arm has a median of zero", () => {
    expect(ratioInterval([], TOOL)).toBeNull();
    expect(ratioInterval(MANUAL, [])).toBeNull();
    expect(ratioInterval(MANUAL, [0, 0, 5])).toBeNull();
  });
});
