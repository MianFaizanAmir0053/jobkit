import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { LlmRequest } from "@/core/ports";

import { NO_ANSWER, scriptedLlm, setScriptedAnswers } from "./scriptedModels";

/* The test server's models: each model answers from its own script (platform spec A3, B10). */

const request = (model: string): LlmRequest => ({
  model,
  system: "",
  content: [],
  schema: z.object({}),
  effort: "low",
  maxTokens: 100,
  signal: new AbortController().signal,
  onEvent: () => undefined,
});

afterEach(() => {
  setScriptedAnswers({});
});

describe("scriptedLlm", () => {
  it("answers each model from its own script, so stages that ask at once never take each other's answers", async () => {
    setScriptedAnswers({
      "gemini-3.8-flash": [{ read: "post" }],
      "gemini-3.6-flash": [{ read: "crop" }],
    });
    const llm = scriptedLlm();

    const crop = await llm.call(request("gemini-3.6-flash"));
    const post = await llm.call(request("gemini-3.8-flash"));

    expect(
      [post, crop].map((reply) => (reply.kind === "answer" ? reply.text : reply.kind)),
    ).toEqual(['{"read":"post"}', '{"read":"crop"}']);
    await expect(llm.call(request("gemini-3.8-flash"))).rejects.toThrow(NO_ANSWER);
    await expect(llm.call(request("claude-opus-5-5"))).rejects.toThrow(NO_ANSWER);
  });
});
