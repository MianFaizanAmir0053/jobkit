import { describe, expect, it } from "vitest";

import { median, percentile } from "./stats";

describe("percentile", () => {
  it("interpolates between the closest ranks", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(91);
  });

  it("does not care about the input order, and leaves the input alone", () => {
    const values = [30, 10, 20];

    expect(percentile(values, 50)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  it("gives the only value of a single run, and null for none", () => {
    expect(percentile([42], 90)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });

  it("refuses a percentile outside 0 to 100", () => {
    expect(() => percentile([1], 101)).toThrow(/0 to 100/);
  });
});

describe("median", () => {
  it("is the 50th percentile", () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
