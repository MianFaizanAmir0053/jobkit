import { describe, expect, it } from "vitest";

import { estimateInputTokens, MODEL_CALL_LIMITS, providerOf } from "./models";
import { RUNNER_LIMITS } from "./runner";

describe("MODEL_CALL_LIMITS", () => {
  it("gives up where platform spec B4 says, so a model stage's worst case is its 225 seconds", () => {
    // A stream silent for 45 seconds is abandoned, the attempts end 200 seconds in, the one
    // retry waits 15 at most, and counting the input may take 10. (The wait when the provider
    // names none is the code's own choice, which no spec fixes.)
    expect(MODEL_CALL_LIMITS).toMatchObject({
      idleMs: 45_000,
      totalMs: 200_000,
      maxRetryWaitMs: 15_000,
      countMs: 10_000,
    });
    // The runner starts a model stage only while that worst case still fits (B9).
    expect(RUNNER_LIMITS.modelStageMs).toBe(225_000);
  });
});

describe("providerOf", () => {
  it("routes Claude and Gemini models, and refuses any other", () => {
    expect(providerOf("claude-opus-5-5")).toBe("anthropic");
    expect(providerOf("gemini-3.8-flash")).toBe("gemini");
    expect(() => providerOf("gpt-x")).toThrow(/No provider/);
  });
});

describe("estimateInputTokens", () => {
  it("counts a third of the characters, and each image at the most it can cost", () => {
    expect(
      estimateInputTokens({
        system: "abc",
        content: [
          { type: "text", text: "defghi" },
          { type: "image", mediaType: "image/png", base64: "" },
        ],
      }),
    ).toBe(3 + 4784);
  });
});
