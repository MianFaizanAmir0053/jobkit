import { readExtractOutput } from "@/core/extraction/extract";
import { chosenRole, type KitOf } from "@/core/extraction/owner";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db } from "@/core/ports";
import { getActiveProfile, getProfileVersion } from "@/core/profile/profile";
import { SKILLS } from "@/core/shared/skills";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import { BUILD_VERSION, draftKitFor, NO_PROFILE } from "./draftStage";
import {
  MAX_ADDED_FACTS,
  MAX_TEMPLATE_DRAFTS,
  TEMPLATE_COVERAGE,
  type TemplateDraft,
  templateDrafts,
} from "./templateDrafts";

/**
 * The `templates` stage (decisions A21, with amendment A22): code only, the
 * first stage of drafting. It drafts from the owner's approved email
 * templates (templateDrafts.ts); when one covers enough of the role, the kit
 * is ready at once with up to two drafts, and the owner can still ask for a
 * Gemini draft beside them. When none does, `draft` writes the email as
 * before. A route that takes a message gets no template draft, since the
 * templates are emails: `draft` writes the message. The address stages run
 * beside it, as they do beside `draft`.
 */

/** Raise it when templateDrafts.ts changes what it drafts, so an output kept from before is not reused. */
const TEMPLATES_VERSION = 2;

const BUILD = sha256Hex(
  canonicalJson({
    templates: TEMPLATES_VERSION,
    limits: [TEMPLATE_COVERAGE, MAX_TEMPLATE_DRAFTS, MAX_ADDED_FACTS],
    build: BUILD_VERSION,
    skills: SKILLS,
  }),
);

export interface TemplatesOutput {
  /** The drafts, best first; none when no template covers enough of the role. */
  drafts: TemplateDraft[];
}

interface TemplatesInput {
  record: string;
  role: string;
  profile: string | null;
  build: string;
  /** The kit the job takes, named only when it is no email, which the templates never draft. */
  kit?: "message" | "form";
}

export function templatesStage(deps: { db: Db; kitOf?: KitOf }): StageDefinition {
  return {
    callsModel: false,

    // B9: the record's output hash, the chosen role, the profile version, the build's version.
    async input(ctx): Promise<TemplatesInput> {
      const extract = await ctx.outputOf("extract");
      const role = await chosenRole(deps.db, ctx.job.id);
      if (!extract || !role) throw new Error("templates runs only after extract has chosen a role");
      const profile = await getActiveProfile(deps.db);
      const kit = await draftKitFor(deps, ctx.job.id, role);
      return {
        record: extract.outputHash,
        role: role.id,
        profile: profile?.versionId ?? null,
        build: BUILD,
        ...(kit === "email" ? {} : { kit }),
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as TemplatesInput;
      if (input.profile === null) return { ok: false, reason: NO_PROFILE, retry: false };
      const profile = await getProfileVersion(deps.db, input.profile);
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      const role = extraction?.record.roles.find((entry) => entry.id === input.role);
      if (!profile || !extraction || !role) {
        throw new Error("templates' input names a profile, record or role that is gone");
      }
      const output: TemplatesOutput = {
        drafts:
          input.kit === undefined
            ? templateDrafts({ record: extraction.record, role, profile })
            : [],
      };
      return { ok: true, output };
    },

    next(_ctx, raw): Transition {
      const { drafts } = raw as TemplatesOutput;
      return drafts.length > 0
        ? { state: "kit_ready", pending: null }
        : { state: "drafting", pending: "draft" };
    },
  };
}
