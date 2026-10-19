import { z } from "zod";

import { readExtractOutput } from "@/core/extraction/extract";
import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import type { DraftOutput } from "./draftStage";
import {
  type BlockVerdict,
  citedFacts,
  JUDGE_LAYOUT_VERSION,
  FORM_JUDGE_RULES,
  JUDGE_RULES,
  judgeAnswerSchema,
  judgeContent,
  mergeVerdicts,
} from "./judge";

/**
 * The `judge` stage (drafting spec, "Stage judge"): one Gemini 3.8 Flash call
 * at low effort, independent of the drafter, with a verdict for every block
 * of the kit. Overstated and unsupported claims, and any claim about the
 * company, are shown on the job page for the owner to check before sending
 * (the review page's "I checked this" and its gate come later).
 */

export const JUDGE = {
  model: "gemini-3.8-flash",
  effort: "low" satisfies Effort,
  maxTokens: 16_000,
} as const;

const PROMPT = sha256Hex(
  canonicalJson({
    rules: JUDGE_RULES,
    layout: JUDGE_LAYOUT_VERSION,
    schema: z.toJSONSchema(judgeAnswerSchema),
  }),
);

/**
 * A form's: its user turn has its own layout, which an email's and a
 * message's must not see change. Raise it when judgeContent changes for a form.
 */
const FORM_PROMPT = sha256Hex(
  canonicalJson({
    kit: "form",
    rules: FORM_JUDGE_RULES,
    layout: JUDGE_LAYOUT_VERSION,
    formLayout: 2,
    schema: z.toJSONSchema(judgeAnswerSchema),
  }),
);

const PASSING: ReadonlySet<ModelCallFailure> = new Set(["timeout", "unavailable"]);

export interface JudgeOutput {
  checked: true;
  verdicts: BlockVerdict[];
  markers: string[];
}

interface JudgeInput {
  draft: string;
  facts: string;
  model: string;
  effort: Effort;
  prompt: string;
}

export interface JudgeDeps {
  db: Db;
  random: Random;
  models: ModelCallDeps;
}

export function judgeStage(deps: JudgeDeps): StageDefinition {
  return {
    callsModel: true,

    // B9: the draft's output hash, the cited facts' hash, the model's settings.
    async input(ctx): Promise<JudgeInput> {
      const draft = await ctx.outputOf("draft");
      if (!draft) throw new Error("judge runs only after draft");
      const output = draft.output as DraftOutput;
      const profile = await getProfileVersion(deps.db, output.profileVersion);
      const facts = profile ? citedFacts(output.kit, profile.facts) : [];
      return {
        draft: draft.outputHash,
        facts: sha256Hex(canonicalJson(facts)),
        model: JUDGE.model,
        effort: JUDGE.effort,
        prompt: output.kit.kind === "form" ? FORM_PROMPT : PROMPT,
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as JudgeInput;
      const draft = (await ctx.outputOf("draft"))?.output as DraftOutput | undefined;
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      const role = extraction?.record.roles.find((entry) => entry.id === draft?.roleId);
      const profile = draft ? await getProfileVersion(deps.db, draft.profileVersion) : null;
      if (!draft || !extraction || !role || !profile) {
        throw new Error("judge's draft, record, role or profile is gone");
      }
      const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
      const called = await callModel(deps.models, {
        stage: "judge",
        jobId: ctx.job.id,
        model: input.model,
        system: draft.kit.kind === "form" ? FORM_JUDGE_RULES : JUDGE_RULES,
        content: judgeContent(
          draft.kit,
          citedFacts(draft.kit, profile.facts),
          { record: extraction.record, role },
          marker,
        ),
        schema: judgeAnswerSchema,
        effort: input.effort,
        maxTokens: JUDGE.maxTokens,
      });
      if (!called.ok)
        return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };
      const output: JudgeOutput = {
        checked: true,
        verdicts: mergeVerdicts(draft.kit, called.output),
        markers: [marker],
      };
      return { ok: true, output };
    },

    next(): Transition {
      return { state: "kit_ready", pending: null };
    },
  };
}
