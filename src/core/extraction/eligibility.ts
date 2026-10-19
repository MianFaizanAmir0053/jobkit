import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Clock, Db } from "@/core/ports";
import { getActiveProfile, getProfileVersion } from "@/core/profile/profile";

import { checkEligibility, type Eligibility, offsetMinutes } from "./eligibilityCheck";
import { readExtractOutput } from "./extract";
import { chosenRole, draftedAnyway, kitByRoute, type KitOf } from "./owner";

/**
 * The `eligibility` stage (extraction spec, "Stage eligibility"):
 * deterministic code, no model, run before any drafting. It compares the
 * chosen role with the profile's fixed answers (eligibilityCheck.ts).
 * `likely_ineligible` moves the job to `needs_eligibility_decision`, where
 * the owner chooses Draft anyway or Skip; `unclear` goes on to drafting, its
 * reasons shown with the kit; after Draft anyway the chain goes on whatever
 * the check finds.
 */

export interface EligibilityOutput extends Eligibility {
  checked: true;
}

export const NO_PROFILE_YET =
  "There is no profile yet. Seed it on the laptop with npm run profile:seed, then press Retry.";

interface EligibilityInput {
  record: string;
  role: string;
  profile: string | null;
  /** Whether the owner chose Draft anyway for this role on this record. */
  draftAnyway: boolean;
  /** The role's zone's offset from UTC now, so a check is not reused across a change of clocks. */
  zoneOffset: number | null;
}

export function eligibilityStage(deps: { db: Db; clock: Clock; kitOf?: KitOf }): StageDefinition {
  return {
    callsModel: false,

    // B9: the record's output hash, the chosen role, the profile version, the owner's decision,
    // and the zone's offset today, on which the overlap turns.
    async input(ctx): Promise<EligibilityInput> {
      const extract = await ctx.outputOf("extract");
      const role = await chosenRole(deps.db, ctx.job.id);
      if (!extract || !role) {
        throw new Error("eligibility runs only after extract has chosen a role");
      }
      const profile = await getActiveProfile(deps.db);
      return {
        record: extract.outputHash,
        role: role.id,
        profile: profile?.versionId ?? null,
        draftAnyway: await draftedAnyway(deps.db, ctx.job.id),
        zoneOffset: offsetMinutes(role.location.time_zone.zone.trim(), deps.clock.now()),
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as EligibilityInput;
      if (input.profile === null) return { ok: false, reason: NO_PROFILE_YET, retry: false };
      const profile = await getProfileVersion(deps.db, input.profile);
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      const role = extraction?.record.roles.find((entry) => entry.id === input.role);
      if (!profile || !role) {
        throw new Error("eligibility's input names a profile or role that is gone");
      }
      const checked = checkEligibility(
        role,
        { home: profile.owner.location.country, fixedAnswers: profile.fixedAnswers },
        deps.clock.now(),
      );
      const output: EligibilityOutput = { checked: true, ...checked };
      return { ok: true, output };
    },

    async next(ctx, raw): Promise<Transition> {
      const output = raw as EligibilityOutput;
      if (output.result === "likely_ineligible" && !(await draftedAnyway(deps.db, ctx.job.id))) {
        return { state: "needs_eligibility_decision", pending: null };
      }
      // A post that does not say how to apply waits for the owner to name the kit (drafting spec,
      // "Kit type"); then the owner's templates come first (decisions A22).
      const role = await chosenRole(deps.db, ctx.job.id);
      if (role && (await (deps.kitOf ?? kitByRoute)(deps.db, ctx.job.id, role)) === null) {
        return { state: "needs_kit_type", pending: null };
      }
      return { state: "drafting", pending: "templates" };
    },
  };
}
