import { describe, expect, it } from "vitest";

import { costOf, provisionalCost } from "./prices";

const OCT_2026 = new Date("2026-10-09T09:00:00Z");
const JAN_2027 = new Date("2027-01-01T00:00:00Z");
const M = 1_000_000;

function usage(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

describe("costOf", () => {
  it("prices Claude Opus 5.5 at $4 in and $20 out per million tokens, cache reads at $0.20", () => {
    expect(costOf(usage("claude-opus-5-5", M, M, M), OCT_2026)).toEqual({ usd: 24.2, known: true });
  });

  it("prices each fallback model at its own rates", () => {
    expect(costOf(usage("claude-opus-4-8", M, M), OCT_2026)).toEqual({ usd: 30, known: true });
    expect(costOf(usage("claude-sonnet-5-5", M, M), OCT_2026)).toEqual({ usd: 12, known: true });
  });

  it("prices Gemini 3.8 Flash at Google's paid rates, which double from 2027", () => {
    expect(costOf(usage("gemini-3.8-flash", M, M), OCT_2026)).toEqual({ usd: 4.5, known: true });
    expect(costOf(usage("gemini-3.8-flash", M, M), JAN_2027)).toEqual({ usd: 9, known: true });
  });

  it("charges an unknown model at the highest rates in the table, and says it is unknown", () => {
    const unknown = costOf(usage("claude-something-new", M, M), OCT_2026);

    expect(unknown.known).toBe(false);
    expect(unknown.usd).toBeGreaterThanOrEqual(
      costOf(usage("claude-fable-5-1", M, M), OCT_2026).usd,
    );
  });

  it("prices a dated snapshot as its model", () => {
    expect(costOf(usage("claude-opus-4-8-20260301", M, M), OCT_2026)).toEqual({ usd: 30, known: true });
  });

  it("rounds to a millionth of a dollar", () => {
    expect(costOf(usage("claude-opus-5-5", 1, 1), OCT_2026).usd).toBe(0.000024);
  });
});

describe("provisionalCost", () => {
  it("is the upper bound: the counted input at the input rate plus max_tokens at the output rate", () => {
    expect(provisionalCost("claude-opus-5-5", 10_000, 16_000, OCT_2026)).toEqual({
      usd: 0.36,
      known: true,
    });
  });
});
