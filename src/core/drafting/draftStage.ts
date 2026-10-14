import { z } from "zod";

import { readExtractOutput } from "@/core/extraction/extract";
import type { JobRecord, Role } from "@/core/extraction/record";
import { chosenRole } from "@/core/extraction/owner";
import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random } from "@/core/ports";
import { getActiveProfile, getProfileVersion } from "@/core/profile/profile";
import { SKILLS } from "@/core/shared/skills";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import { acceptedInstructions, buildEmailKit, oneLine } from "./build";
import { draftAnswerSchema, type EmailKit, type FitRow } from "./kit";
import { DRAFT_LAYOUT_VERSION, draftContent, draftSystemPrompt } from "./prompt";
import { hasWord, type KitFlag, validateEmailKit } from "./validate";

/**
 * The `draft` stage for an email kit (drafting spec, "Stage draft"): one
 * Gemini 3.8 Flash call with the approved profile and the chosen role's typed
 * fields, never raw post text, for the fit table and the body's blocks. Code
 * then writes the subject, greeting, gap lines and closing, and runs the
 * checks; the kit is kept with its flags for the owner to review. On the
 * thin path every route gets an email kit (form and message kits, the
 * kit-type pick and topic questions come later), and the declined
 * instructions are always none, since the review checklist does not exist yet.
 */

export const DRAFT = {
  model: "gemini-3.8-flash",
  effort: "medium" satisfies Effort,
  maxTokens: 16_000,
} as const;

/**
 * What a stored kit holds beyond the model's answer: the parts code builds,
 * the flags it raises, and what the call is shown. Raise it when any of
 * these change: build.ts, validate.ts, fit.ts, bodyWords in kit.ts, the
 * skill lookup in skills.ts (skillTag and its key), or withoutAiLines
 * below, so an output kept from before is not reused. The skills table's
 * data is hashed whole.
 */
const BUILD_VERSION = 4;

// The prompt as sent (its rules, the user turn's layout, the output's schema) and the build.
const PROMPT = sha256Hex(
  canonicalJson({
    rules: draftSystemPrompt(0),
    layout: DRAFT_LAYOUT_VERSION,
    schema: z.toJSONSchema(draftAnswerSchema),
    build: BUILD_VERSION,
    skills: SKILLS,
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
  /** The post's subject format code applied, so validate can run again from what is stored. */
  subjectFormat: string | null;
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
      const post = withoutAiLines(extraction.record, role, accepted.keyword);
      const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
      const called = await callModel(deps.models, {
        stage: "draft",
        jobId: ctx.job.id,
        model: input.model,
        system: draftSystemPrompt(accepted.wordLimit),
        content: draftContent(profile, post, accepted.wordLimit, marker),
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
        keyword: post.keyword,
        subjectFormat: accepted.subjectFormat,
        markers: [marker],
      });
      const output: DraftOutput = {
        kit,
        fit,
        flags,
        wordLimit: accepted.wordLimit,
        keyword: post.keyword,
        subjectFormat: accepted.subjectFormat,
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

/**
 * The post's typed fields as the drafting call may see them. The extract
 * prompt records lines aimed at AI as instructions or questions, which the
 * role passed on goes without; a requirement, a title or a company name
 * that repeats such a line, or what it asks for, as whole words, is left
 * out too (the fit check then shows the requirement as not weighed), as is
 * a skill tag that does, and a keyword that does is not taken at all, since
 * the kit could not both use it and leave it out. Lines and values under
 * three characters drop nothing: they would match ordinary words. A line
 * the extractor reworded into a requirement is beyond this check: the
 * markers and the system prompt's rule are the defence there.
 */
function withoutAiLines(
  record: JobRecord,
  role: Role,
  keyword: string | null,
): { company: string; role: Role; keyword: string | null } {
  const lines = record.roles
    .flatMap((each) => [
      ...each.instructions
        .filter((line) => line.addressed_to_ai)
        .flatMap((line) => [line.text, line.value]),
      ...each.screening_questions.filter((line) => line.addressed_to_ai).map((line) => line.text),
    ])
    .map(oneLine)
    .filter((line) => [...line].length >= 3);
  // Whole words, on one line: "Java" leaves "JavaScript" alone, and a line break hides nothing.
  const touched = (text: string) => lines.some((line) => hasWord(oneLine(text), line));
  return {
    company: touched(record.company.name) ? "" : record.company.name,
    role: {
      ...role,
      title: touched(role.title) ? "" : role.title,
      requirements: role.requirements
        .filter((requirement) => !touched(requirement.text))
        .map((requirement) => ({
          ...requirement,
          skills: requirement.skills.filter((skill) => !touched(skill)),
        })),
      instructions: [],
      screening_questions: [],
    },
    keyword: keyword !== null && touched(keyword) ? null : keyword,
  };
}
