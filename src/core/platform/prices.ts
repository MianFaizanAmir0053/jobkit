import type { LlmUsage } from "@/core/ports";

/**
 * The price table (platform spec B4), in US dollars per million tokens.
 * Check it against the providers' pricing pages whenever it changes:
 * - Claude, from Anthropic's model table on 2026-10-09: Opus 5.5 $4 and $20
 *   with cache reads at $0.20; the models a refusal can fall back to at their
 *   own rates. Cache writes are the five-minute rate, 1.25 times input; the
 *   MVP sends no cache breakpoints, so they should stay at zero.
 * - Gemini 3.8 Flash, from https://ai.google.dev/gemini-api/docs/pricing on
 *   2026-10-09: $0.75 and $3.75 (thinking billed as output), doubling on
 *   2027-01-01. Gemini 3.6 Flash, from the same page on 2026-10-14: the same.
 *   Gemini 3.1 Pro preview ($2 and $12) and Gemini 2.5 Pro ($1.25 and $10),
 *   from the same page on 2026-10-14, at their rates for prompts of up to
 *   200,000 tokens, which no stage comes near; their cache rates are taken
 *   as a tenth of input, as Flash's are, since jobkit caches nothing.
 * Thinking tokens arrive inside the output count from both providers.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type UsageEntry = LlmUsage;

const claude = (input: number, output: number, cacheRead: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

// Each model's rates, in order, each from its date (inclusive) until the next.
const PRICES: Readonly<Record<string, readonly { from?: string; rates: Rates }[]>> = {
  "claude-opus-5-5": [{ rates: claude(4, 20, 0.2) }],
  "claude-opus-5": [{ rates: claude(5, 25, 0.5) }],
  "claude-opus-4-8": [{ rates: claude(5, 25, 0.5) }],
  "claude-sonnet-5-5": [{ rates: claude(2, 10, 0.2) }],
  "claude-sonnet-5": [{ rates: claude(2, 10, 0.2) }],
  "claude-fable-5-1": [{ rates: claude(10, 50, 0.25) }],
  "gemini-3.8-flash": [
    { rates: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 } },
    { from: "2027-01-01", rates: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 } },
  ],
  "gemini-3.6-flash": [
    { rates: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 } },
    { from: "2027-01-01", rates: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 } },
  ],
  "gemini-3.1-pro-preview": [{ rates: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 } }],
  "gemini-2.5-pro": [{ rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 } }],
};

/** An unknown model counts at the highest rates anywhere in the table, so the cap errs high. */
const HIGHEST: Rates = Object.values(PRICES)
  .flat()
  .reduce(
    (max, { rates }) => ({
      input: Math.max(max.input, rates.input),
      output: Math.max(max.output, rates.output),
      cacheRead: Math.max(max.cacheRead, rates.cacheRead),
      cacheWrite: Math.max(max.cacheWrite, rates.cacheWrite),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );

function ratesFor(model: string, at: Date): { rates: Rates; known: boolean } {
  // A dated snapshot such as claude-opus-4-8-20260301 is priced as its model.
  const periods = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  if (!periods) return { rates: HIGHEST, known: false };
  const current = periods.filter((p) => !p.from || new Date(p.from).getTime() <= at.getTime());
  return { rates: current[current.length - 1]!.rates, known: true };
}

const PER_MILLION = 1_000_000;

export function roundUsd(amount: number): number {
  return Math.round(amount * PER_MILLION) / PER_MILLION;
}

export function costOf(entry: UsageEntry, at: Date): { usd: number; known: boolean } {
  const { rates, known } = ratesFor(entry.model, at);
  const usd =
    (entry.inputTokens * rates.input +
      entry.outputTokens * rates.output +
      entry.cacheReadTokens * rates.cacheRead +
      entry.cacheWriteTokens * rates.cacheWrite) /
    PER_MILLION;
  return { usd: roundUsd(usd), known };
}

/**
 * The upper bound an attempt is charged until its real usage arrives, and for
 * good if it never does: its counted input at the input rate, plus the whole
 * max_tokens at the output rate (B4). It bounds one run of the requested
 * model. With refusal fallbacks on, a declined run plus its fallback can cost
 * more; their usage arrives with the final message, so only an attempt that
 * falls back and then breaks off is undercounted, by at most its fallback run.
 */
export function provisionalCost(
  model: string,
  inputTokens: number,
  maxTokens: number,
  at: Date,
): { usd: number; known: boolean } {
  const { rates, known } = ratesFor(model, at);
  return {
    usd: roundUsd((inputTokens * rates.input + maxTokens * rates.output) / PER_MILLION),
    known,
  };
}
