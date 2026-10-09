import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { LlmRequest } from "@/core/ports";

import type { ModelCallInput } from "./models";

/**
 * Platform spec B4 and AC12: no stage can hand a model tools while it reads
 * post text. These checks run in the type checker: adding a tools field to
 * either type makes `npm run typecheck` fail.
 */
describe("the model-call types", () => {
  it("have no field for tools", () => {
    expectTypeOf<
      "tools" extends keyof ModelCallInput<unknown> ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "tool_choice" extends keyof ModelCallInput<unknown> ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<"tools" extends keyof LlmRequest ? true : false>().toEqualTypeOf<false>();

    const withTools: ModelCallInput<{ a: string }> = {
      stage: "extract",
      jobId: null,
      model: "claude-opus-5-5",
      system: "",
      content: [],
      schema: z.object({ a: z.string() }),
      effort: "high",
      maxTokens: 1000,
      // @ts-expect-error The input has no field for tools.
      tools: [],
    };
    void withTools;
  });
});
