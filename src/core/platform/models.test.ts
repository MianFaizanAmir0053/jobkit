import { describe, expect, it } from "vitest";

import { estimateInputTokens, providerOf } from "./models";

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
