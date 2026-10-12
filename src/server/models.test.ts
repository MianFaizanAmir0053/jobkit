import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fakeLlm } from "@/adapters/fakeLlm";

import { lazyLlm, modelsFor } from "./models";
import { NO_ANSWER, setScriptedAnswers } from "./scriptedModels";

const countable = {
  model: "claude-opus-5-5",
  system: "s",
  content: [],
  schema: z.object({}),
  effort: "low" as const,
  maxTokens: 10,
};

describe("modelsFor", () => {
  it("in production, runs Claude and Gemini on the app's keys", () => {
    const llmFor = modelsFor("production", {
      ANTHROPIC_API_KEY: "app-key",
      GEMINI_API_KEY: "app-key",
    });

    expect(llmFor("claude-opus-5-5")).toMatchObject({ call: expect.any(Function) });
    expect(llmFor("gemini-3.8-flash")).toMatchObject({ call: expect.any(Function) });
  });

  it("in production, fails only the model whose key is missing", () => {
    const llmFor = modelsFor("production", { GEMINI_API_KEY: "app-key" });

    expect(llmFor("gemini-3.8-flash")).toMatchObject({ call: expect.any(Function) });
    expect(() => llmFor("claude-opus-5-5")).toThrow(
      "ANTHROPIC_API_KEY is not set, so claude-opus-5-5 cannot run here",
    );
  });

  it("in development, uses only the evaluation keys, never the app's", () => {
    const llmFor = modelsFor("development", {
      ANTHROPIC_API_KEY: "app-key",
      ANTHROPIC_EVALS_API_KEY: "evals-key",
      GEMINI_API_KEY: "app-key",
    });

    expect(llmFor("claude-opus-5-5")).toMatchObject({ call: expect.any(Function) });
    expect(() => llmFor("gemini-3.8-flash")).toThrow(
      "GEMINI_EVALS_API_KEY is not set, so gemini-3.8-flash cannot run here",
    );
  });

  it("in tests, answers only from the script, whatever keys are set, never loading a provider", async () => {
    const llmFor = modelsFor("test", {
      ANTHROPIC_API_KEY: "app-key",
      ANTHROPIC_EVALS_API_KEY: "evals-key",
    });
    setScriptedAnswers([{ post_kind: "job_post" }]);

    const reply = await llmFor("claude-opus-5-5").call({
      model: "claude-opus-5-5",
      system: "",
      content: [],
      schema: z.object({}),
      effort: "medium",
      maxTokens: 10,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });

    expect(reply).toMatchObject({
      kind: "answer",
      text: '{"post_kind":"job_post"}',
      requestId: "scripted",
    });
    await expect(
      llmFor("gemini-3.8-flash").call({
        model: "gemini-3.8-flash",
        system: "",
        content: [],
        schema: z.object({}),
        effort: "low",
        maxTokens: 10,
        signal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(NO_ANSWER);
    expect(() => llmFor("gpt-5")).toThrow(/No provider serves/);
  });

  it("refuses a model no provider serves", () => {
    expect(() => modelsFor("production", {})("gpt-5")).toThrow(/No provider serves/);
  });

  it("tries a load that failed again on the next call, rather than keeping the failure", async () => {
    let loads = 0;
    const llm = lazyLlm("app-key", async () => {
      loads += 1;
      if (loads === 1) throw new Error("the chunk was locked");
      return fakeLlm([], { inputTokens: 42 });
    });

    await expect(llm!.countInputTokens(countable)).rejects.toThrow("the chunk was locked");
    expect(await llm!.countInputTokens(countable)).toBe(42);
    expect(await llm!.countInputTokens(countable)).toBe(42);
    expect(loads).toBe(2);
  });

  it("loads the adapter on first use, and a fault in the request then surfaces from the call", async () => {
    const llm = modelsFor("production", { ANTHROPIC_API_KEY: "app-key" })("claude-opus-5-5");

    // A schema the API cannot take fails before anything is sent, so this
    // reaches the loaded adapter without touching the network.
    await expect(
      llm.call({
        model: "claude-opus-5-5",
        system: "s",
        content: [],
        schema: z.object({ at: z.date() }),
        effort: "low",
        maxTokens: 10,
        signal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow();
  });
});
