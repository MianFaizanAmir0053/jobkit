/**
 * Live contract test against the Claude API, on the evaluation key, so it
 * spends from the evaluation workspace: usually a few cents a run, and at
 * most about fifteen, since the second test lets Claude Opus 5.5 think for up
 * to 6,000 output tokens at $20 a million. Runs only by hand, with the
 * owner's approval, through `npx vitest run --mode live
 * src/adapters/anthropic.live.test.ts`, with .env.local filled in.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { LlmRequest } from "@/core/ports";

import { loadLocalEnv } from "../../scripts/ops";
import { createAnthropicLlm } from "./anthropic";

const key = loadLocalEnv().ANTHROPIC_EVALS_API_KEY;
if (!key) throw new Error("ANTHROPIC_EVALS_API_KEY is missing from .env.local");
const llm = createAnthropicLlm({ apiKey: key });

const capital = z.object({
  city: z.string(),
  country: z.string().nullable(),
  continent: z.enum(["Africa", "Asia", "Europe", "North America", "Oceania", "South America"]),
});

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-opus-5-5",
    system: "Answer briefly, in the requested format.",
    content: [{ type: "text", text: "Which city is the capital of France?" }],
    schema: capital,
    effort: "low",
    maxTokens: 2000,
    signal: AbortSignal.timeout(120_000),
    onEvent: () => undefined,
    ...overrides,
  };
}

describe("Claude through the adapter", () => {
  it("answers in the schema's shape, with usage, the answering model and the request ID", async () => {
    const counted = await llm.countInputTokens(request());
    const reply = await llm.call(request());

    expect(reply).toMatchObject({ kind: "answer", truncated: false });
    if (reply.kind !== "answer") return;
    expect(capital.parse(JSON.parse(reply.text))).toMatchObject({ city: "Paris" });
    expect(reply.model).toBe("claude-opus-5-5");
    expect(reply.requestId).toMatch(/^req_/);
    expect(reply.usage).toHaveLength(1);
    const [usage] = reply.usage;
    expect(usage!.outputTokens).toBeGreaterThan(0);
    // The count is an estimate of the same input.
    expect(counted).toBeGreaterThan(usage!.inputTokens / 2);
    expect(counted).toBeLessThan(usage!.inputTokens * 2);
  }, 150_000);

  it("keeps sending while the model thinks with its thinking hidden", async () => {
    // From the moment of sending, as the wrapper's idle timer counts.
    const arrivals = [Date.now()];

    const reply = await llm.call(
      request({
        content: [
          {
            type: "text",
            text: "How many primes are there below 500? Check your count carefully, then answer with the number as the city.",
          },
        ],
        schema: z.object({ city: z.string() }),
        effort: "medium",
        maxTokens: 6_000,
        onEvent: () => arrivals.push(Date.now()),
      }),
    );

    const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]!);
    const longest = Math.max(0, ...gaps);
    console.info(`${arrivals.length - 1} arrivals, longest silence ${longest} ms`);
    expect(reply).toMatchObject({ kind: "answer", truncated: false });
    // The wrapper abandons a stream silent for 45 seconds (platform spec B4).
    expect(longest).toBeLessThan(45_000);
  }, 150_000);
});
