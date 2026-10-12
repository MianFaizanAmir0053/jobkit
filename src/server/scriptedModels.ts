import type { Llm, LlmReply } from "@/core/ports";

/**
 * The test server's models (platform spec A3 and B10; Task 26): answers the
 * end-to-end tests set in order through a test-only route, so a job runs
 * through every stage with no key and no spending, and keys sit nowhere near
 * the test server. Each provider keeps its own queue, since Gemini's second
 * read of a contact runs beside Claude's draft and either may ask first.
 * Each call takes its provider's next answer; with none left it throws,
 * failing its stage with the cause recorded. The answers live on
 * globalThis, as the container does, so the route and the stages share them
 * across the dev server's reloads.
 */

export type Provider = "anthropic" | "gemini";

const shared = globalThis as typeof globalThis & {
  jobkitScriptedAnswers?: Partial<Record<Provider, unknown[]>>;
};

export const NO_ANSWER = "The test server has no model answer left";

export function setScriptedAnswers(
  answers: readonly unknown[],
  provider: Provider = "anthropic",
): void {
  shared.jobkitScriptedAnswers = { ...shared.jobkitScriptedAnswers, [provider]: [...answers] };
}

export function scriptedLlm(provider: Provider = "anthropic"): Llm {
  return {
    async countInputTokens() {
      return 1_000;
    },
    async call(request): Promise<LlmReply> {
      const answers = shared.jobkitScriptedAnswers?.[provider] ?? [];
      if (answers.length === 0) throw new Error(NO_ANSWER);
      const answer = answers.shift();
      return {
        kind: "answer",
        text: typeof answer === "string" ? answer : JSON.stringify(answer),
        model: request.model,
        requestId: "scripted",
        usage: [
          {
            model: request.model,
            inputTokens: 1_000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
        truncated: false,
      };
    },
  };
}
