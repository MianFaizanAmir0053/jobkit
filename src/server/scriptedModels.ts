import type { Llm, LlmReply } from "@/core/ports";

/**
 * The test server's models (platform spec A3 and B10; Task 26): answers the
 * end-to-end tests set in order through a test-only route, so a job runs
 * through every stage with no key and no spending, and keys sit nowhere near
 * the test server. Each model keeps its own queue, since the second read of
 * a contact runs beside the draft on another model and either may ask
 * first. Each call takes its model's next answer; with none left it throws,
 * failing its stage with the cause recorded. The answers live on
 * globalThis, as the container does, so the route and the stages share them
 * across the dev server's reloads.
 */

const shared = globalThis as typeof globalThis & {
  jobkitScriptedAnswers?: Record<string, unknown[]>;
};

export const NO_ANSWER = "The test server has no model answer left";

/** Sets each model's answers, in the order its stages will ask; a model not named has none. */
export function setScriptedAnswers(byModel: Readonly<Record<string, readonly unknown[]>>): void {
  shared.jobkitScriptedAnswers = Object.fromEntries(
    Object.entries(byModel).map(([model, answers]) => [model, [...answers]]),
  );
}

export function scriptedLlm(): Llm {
  return {
    async countInputTokens() {
      return 1_000;
    },
    async call(request): Promise<LlmReply> {
      const answers = shared.jobkitScriptedAnswers?.[request.model] ?? [];
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
