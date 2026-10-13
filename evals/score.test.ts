import { describe, expect, it } from "vitest";

import { compareModels, fieldMatches, mcnemarExact, precisionRecall, wilson } from "./score";

/* The scorer: evals AC4, on fixed inputs with known answers. */

const rows = <T>(count: number, row: T): T[] => Array.from({ length: count }, () => row);

describe("wilson", () => {
  it("leaves 30 of 30 a 95% lower bound near 89%, and 10 of 10 near 72%", () => {
    expect(wilson(30, 30)).toMatchObject({ successes: 30, n: 30, point: 1, high: 1 });
    expect(wilson(30, 30).low).toBeCloseTo(0.886487, 6);
    expect(wilson(10, 10)).toMatchObject({ point: 1, high: 1 });
    expect(wilson(10, 10).low).toBeCloseTo(0.722467, 6);
  });

  it("matches published intervals away from the ends, and gives none without cases", () => {
    const eight = wilson(8, 10);
    expect(eight.low).toBeCloseTo(0.490162, 6);
    expect(eight.high).toBeCloseTo(0.943318, 6);
    expect(wilson(0, 10)).toMatchObject({ point: 0, low: 0 });
    expect(wilson(0, 10).high).toBeCloseTo(0.277533, 6);
    expect(wilson(0, 0)).toEqual({ successes: 0, n: 0, point: null, low: null, high: null });
  });

  it("refuses counts that cannot be", () => {
    expect(() => wilson(11, 10)).toThrow();
    expect(() => wilson(-1, 10)).toThrow();
    expect(() => wilson(1.5, 10)).toThrow();
  });
});

describe("precisionRecall", () => {
  it("counts a small labelled table into precision and recall, each with its interval", () => {
    const scored = precisionRecall([
      ...rows(8, { predicted: true, actual: true }),
      ...rows(2, { predicted: true, actual: false }),
      ...rows(4, { predicted: false, actual: true }),
      ...rows(6, { predicted: false, actual: false }),
    ]);

    expect(scored).toMatchObject({
      truePositives: 8,
      falsePositives: 2,
      falseNegatives: 4,
      trueNegatives: 6,
    });
    expect(scored.precision).toMatchObject({ successes: 8, n: 10, point: 0.8 });
    expect(scored.precision.low).toBeCloseTo(0.490162, 6);
    expect(scored.recall).toMatchObject({ successes: 8, n: 12 });
    expect(scored.recall.point).toBeCloseTo(2 / 3, 12);
  });
});

describe("mcnemarExact", () => {
  it("gives the exact two-sided p-value on the cases where only one model was right", () => {
    expect(mcnemarExact(1, 9)).toBe(11 / 512);
    expect(mcnemarExact(9, 1)).toBe(11 / 512);
    expect(mcnemarExact(2, 8)).toBe(56 / 512);
    expect(mcnemarExact(0, 6)).toBe(1 / 32);
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it("stays a probability for more cases than a double can count in powers of two", () => {
    expect(mcnemarExact(600, 600)).toBe(1);
    // The normal approximation gives about 0.0043.
    const p = mcnemarExact(550, 650);
    expect(p).toBeGreaterThan(0.003);
    expect(p).toBeLessThan(0.006);
  });
});

describe("compareModels", () => {
  const pairs = (onlyFirst: number, onlySecond: number, both: number) => [
    ...rows(onlyFirst, { first: true, second: false }),
    ...rows(onlySecond, { first: false, second: true }),
    ...rows(both, { first: true, second: true }),
    { first: false, second: false },
  ];

  it("names the better model only where the test supports it, and otherwise says no difference was shown", () => {
    expect(compareModels(pairs(9, 1, 20))).toEqual({
      onlyFirst: 9,
      onlySecond: 1,
      both: 20,
      neither: 1,
      p: 11 / 512,
      verdict: "first",
    });
    expect(compareModels(pairs(0, 6, 4)).verdict).toBe("second");
    expect(compareModels(pairs(2, 8, 20)).verdict).toBe("no difference shown");
    expect(compareModels(pairs(0, 0, 30)).verdict).toBe("no difference shown");
  });
});

describe("fieldMatches", () => {
  const label = {
    company: "Northwind Analytics",
    role: "Senior React Developer",
    route: "email",
    contact: "jobs@northwind.example",
    eligibility: "eligible",
  };

  it("scores only the fields labelled, as a synthetic post gives only those it expects", () => {
    expect(
      fieldMatches(
        { company: "", role: "", route: "whatsapp", contact: "+1 202 555 0143", eligibility: "" },
        { route: "whatsapp", contact: "202-555-0143" },
      ),
    ).toEqual({ route: true, contact: false });
  });

  it("compares company and role after the ledger's normalisation, and route and eligibility exactly", () => {
    expect(
      fieldMatches(
        {
          company: "NORTHWIND ANALYTICS (Pvt.) Ltd.",
          role: "React Developer (Senior)",
          route: "email",
          contact: " Jobs@Northwind.example ",
          eligibility: "eligible",
        },
        label,
      ),
    ).toEqual({ company: true, role: true, route: true, contact: true, eligibility: true });
    expect(
      fieldMatches(
        {
          company: "Northwind",
          role: "React Developer",
          route: "form",
          contact: "job@northwind.example",
          eligibility: "unclear",
        },
        label,
      ),
    ).toEqual({ company: false, role: false, route: false, contact: false, eligibility: false });
  });

  it("takes a number by the number jobkit would message, and an empty contact only for an empty label", () => {
    const whatsapp = { ...label, route: "whatsapp", contact: "0300-1234567" };

    expect(fieldMatches({ ...whatsapp, contact: "+92 300 1234567" }, whatsapp).contact).toBe(true);
    expect(fieldMatches({ ...whatsapp, contact: "+92 300 1234568" }, whatsapp).contact).toBe(false);
    // jobkit never guesses a country: a code the post did not give is a different reading.
    const abroad = { ...whatsapp, contact: "202 555 0143" };
    expect(fieldMatches({ ...abroad, contact: "202-555-0143" }, abroad).contact).toBe(true);
    expect(fieldMatches({ ...abroad, contact: "+1 202 555 0143" }, abroad).contact).toBe(false);
    const form = { ...label, route: "form", contact: "" };
    expect(fieldMatches(form, form).contact).toBe(true);
    expect(fieldMatches({ ...label, contact: " " }, label).contact).toBe(false);
  });
});
