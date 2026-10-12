import type { Llm, LlmReply } from "@/core/ports";

/**
 * The test server's models (platform spec A3 and B10; Task 26): answers the
 * end-to-end tests set in order through a test-only route, so a job runs
 * through every stage with no key and no spending, and keys sit nowhere near
 * the test server. Each call takes the next answer; with none left it
 * throws, failing its stage with the cause recorded. The answers live on
 * globalThis, as the container does, so the route and the stages share them
 * across the dev server's reloads.
 */

const shared = globalThis as typeof globalThis & { jobkitScriptedAnswers?: unknown[] };

export const NO_ANSWER = "The test server has no model answer left";

export function setScriptedAnswers(answers: readonly unknown[]): void {
  shared.jobkitScriptedAnswers = [...answers];
}

export function scriptedLlm(): Llm {
  return {
    async countInputTokens() {
      return 1_000;
    },
    async call(request): Promise<LlmReply> {
      const answers = shared.jobkitScriptedAnswers ?? [];
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
