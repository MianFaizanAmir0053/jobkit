import type { StageDefinition, Transition } from "@/core/platform/runner";

/**
 * `judge` on the thin path: it passes the kit through unchecked, so the
 * owner can try a kit before the judge exists (the owner's choice,
 * 2026-10-12). Its output says so, and the job page shows that no separate
 * check ran. Task 24 replaces it with the independent Claude call the
 * drafting spec describes.
 */

export interface JudgeOutput {
  checked: false;
}

export function judgePassThrough(): StageDefinition {
  return {
    callsModel: false,
    // B9: the output hash of the draft it would check.
    async input(ctx) {
      const draft = await ctx.outputOf("draft");
      if (!draft) throw new Error("judge runs only after draft");
      return { draft: draft.outputHash, checked: false };
    },
    async run() {
      const output: JudgeOutput = { checked: false };
      return { ok: true, output };
    },
    next(): Transition {
      return { state: "kit_ready", pending: null };
    },
  };
}
