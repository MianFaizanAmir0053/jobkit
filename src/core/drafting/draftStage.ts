import { z } from "zod";

import { readExtractOutput } from "@/core/extraction/extract";
import { chosenRole } from "@/core/extraction/owner";
import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random } from "@/core/ports";
import { getActiveProfile, getProfileVersion } from "@/core/profile/profile";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import { acceptedInstructions, buildEmailKit } from "./build";
import { draftAnswerSchema, type EmailKit, type FitRow } from "./kit";
import { DRAFT_LAYOUT_VERSION, draftContent, draftSystemPrompt } from "./prompt";
import { type KitFlag, validateEmailKit } from "./validate";

/**
 * The `draft` stage for an email kit (drafting spec, "Stage draft"): one
 * Claude Opus 5.5 call with the approved profile and the chosen role's typed
 * fields, never raw post text, for the fit table and the body's blocks. Code
 * then writes the subject, greeting, gap lines and closing, and runs the
 * checks; the kit is kept with its flags for the owner to review. On the
 * thin path every route gets an email kit (form and message kits, the
 * kit-type pick and topic questions come later), and the declined
 * instructions are always none, since the review checklist does not exist yet.
 */

export const DRAFT = {
  model: "claude-opus-5-5",
  effort: "medium" satisfies Effort,
  maxTokens: 16_000,
} as const;

// The prompt as sent: its rules, the user turn's layout and the output's schema.
const PROMPT = sha256Hex(
  canonicalJson({
    rules: draftSystemPrompt(0),
    layout: DRAFT_LAYOUT_VERSION,
    schema: z.toJSONSchema(draftAnswerSchema),
  }),
);

export const NO_PROFILE =
  "There is no profile yet. Seed it on the laptop with npm run profile:seed, then press Retry.";

const PASSING: ReadonlySet<ModelCallFailure> = new Set(["timeout", "unavailable"]);

export interface DraftOutput {
  kit: EmailKit;
  fit: FitRow[];
  flags: KitFlag[];
  wordLimit: number;
  keyword: string | null;
  markers: string[];
  profileVersion: string;
  roleId: string;
}

interface DraftInput {
  record: string;
  role: string;
  profile: string | null;
  kit: "email";
  declined: string[];
  model: string;
  effort: Effort;
  prompt: string;
}

export interface DraftDeps {
  db: Db;
  random: Random;
  models: ModelCallDeps;
}

export function draftStage(deps: DraftDeps): StageDefinition {
  return {
    callsModel: true,

    // B9: the record's output hash, the chosen role, the profile version, the kit type, the declined instructions, the model's settings.
    async input(ctx): Promise<DraftInput> {
      const extract = await ctx.outputOf("extract");
      const role = await chosenRole(deps.db, ctx.job.id);
      if (!extract || !role) throw new Error("draft runs only after extract has chosen a role");
      const profile = await getActiveProfile(deps.db);
      return {
        record: extract.outputHash,
        role: role.id,
        profile: profile?.versionId ?? null,
        kit: "email",
        declined: [],
        model: DRAFT.model,
        effort: DRAFT.effort,
        prompt: PROMPT,
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as DraftInput;
      if (input.profile === null) return { ok: false, reason: NO_PROFILE, retry: false };
      const profile = await getProfileVersion(deps.db, input.profile);
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      const role = extraction?.record.roles.find((entry) => entry.id === input.role);
      if (!profile || !extraction || !role) {
        throw new Error("draft's input names a profile, record or role that is gone");
      }
      const accepted = acceptedInstructions(role);
      const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
      const called = await callModel(deps.models, {
        stage: "draft",
        jobId: ctx.job.id,
        model: input.model,
        system: draftSystemPrompt(accepted.wordLimit),
        content: draftContent(
          profile,
          { company: extraction.record.company.name, role, keyword: accepted.keyword },
          accepted.wordLimit,
          marker,
        ),
        schema: draftAnswerSchema,
        effort: input.effort,
        maxTokens: DRAFT.maxTokens,
      });
      if (!called.ok)
        return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };

      const parts = {
        facts: profile.facts,
        knownGaps: profile.knownGaps,
        gapTemplates: profile.gapTemplates,
      };
      const { kit, fit } = buildEmailKit(called.output, {
        record: extraction.record,
        role,
        ownerName: profile.owner.name,
        accepted,
        profile: parts,
      });
      const flags = validateEmailKit(kit, {
        record: extraction.record,
        role,
        profile: parts,
        fit,
        wordLimit: accepted.wordLimit,
        keyword: accepted.keyword,
        markers: [marker],
      });
      const output: DraftOutput = {
        kit,
        fit,
        flags,
        wordLimit: accepted.wordLimit,
        keyword: accepted.keyword,
        markers: [marker],
        profileVersion: profile.versionId,
        roleId: role.id,
      };
      return { ok: true, output };
    },

    next(): Transition {
      return { state: "judging", pending: "judge" };
    },
  };
}
