import type { StageDefinition, Transition } from "@/core/platform/runner";
import type { Db } from "@/core/ports";
import { getActiveProfile } from "@/core/profile/profile";

import { chosenRole } from "./owner";

/**
 * `eligibility` on the thin path: it passes every role through unchecked,
 * so the owner can try a kit before the check exists (the owner's choice,
 * 2026-10-12). Its output says so, and the job page tells the owner to
 * check the post's location and work-permit lines themselves. Task 16
 * replaces it with the deterministic check the extraction spec describes,
 * which can stop a job at `needs_eligibility_decision`.
 */

export interface EligibilityOutput {
  result: "not_checked";
}

export function eligibilityPassThrough(db: Db): StageDefinition {
  return {
    callsModel: false,
    // B9: the record's output hash, the chosen role, the profile version, the owner's decision.
    async input(ctx) {
      const extract = await ctx.outputOf("extract");
      const role = await chosenRole(db, ctx.job.id);
      if (!extract || !role)
        throw new Error("eligibility runs only after extract has chosen a role");
      const profile = await getActiveProfile(db);
      return {
        record: extract.outputHash,
        role: role.id,
        profile: profile?.versionId ?? null,
        decision: null,
        checked: false,
      };
    },
    async run() {
      const output: EligibilityOutput = { result: "not_checked" };
      return { ok: true, output };
    },
    next(): Transition {
      return { state: "drafting", pending: "draft" };
    },
  };
}
