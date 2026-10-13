import type { StageDefinition } from "@/core/platform/runner";

import type { DraftOutput } from "./draftStage";

/**
 * For tests: a judge stage that weighs every sentence of the kit and finds
 * it supported, with no model call, so a kit's gate holds only for what a
 * test sets up. A sentence with no verdict would hold it as never weighed.
 */
export function passingJudge(): StageDefinition {
  return {
    callsModel: false,
    input: () => ({}),
    async run(ctx) {
      const draft = (await ctx.outputOf("draft"))?.output as DraftOutput | undefined;
      const verdicts = (draft?.kit.blocks ?? []).map((block) => ({
        blockId: block.id,
        verdict: "supported" as const,
        companyClaim: false,
        note: "",
      }));
      return { ok: true as const, output: { checked: true, verdicts, markers: [] } };
    },
    next: () => ({ state: "kit_ready" as const, pending: null }),
  };
}
