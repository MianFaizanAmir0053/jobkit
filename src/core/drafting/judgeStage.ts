import { z } from "zod";

import { readExtractOutput } from "@/core/extraction/extract";
import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageOutput, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import { addedAnswersOf, withAddedAnswers } from "./answersStage";
import type { DraftOutput } from "./draftStage";
import type { FormKit } from "./kit";
import {
  type BlockVerdict,
  citedFacts,
  JUDGE_LAYOUT_VERSION,
  FORM_JUDGE_RULES,
  JUDGE_RULES,
  draftedAnswers,
  judgeAnswerSchema,
  judgeContent,
  mergeVerdicts,
} from "./judge";

/**
 * The `judge` stage (drafting spec, "Stage judge"): one Gemini 3.8 Flash call
 * at low effort, independent of the drafter, with a verdict for every block
 * of the kit. Overstated and unsupported claims, and any claim about the
 * company, are shown on the job page for the owner to check before sending
 * (the review page's "I checked this" and its gate come later). After
 * `draft_answers` it checks only the answers added to the form since its
 * last check (drafting spec, AC11), and keeps their verdicts apart from the
 * draft's (`answers` names what it checked), so the kit the owner made
 * decisions on keeps its key.
 */

export const JUDGE = {
  model: "gemini-3.8-flash",
  effort: "low" satisfies Effort,
  maxTokens: 16_000,
} as const;

export const JUDGE_PROMPT = sha256Hex(
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
  /** For a check of added answers: the draft_answers output it checked; absent for the draft's. */
  answers?: string;
  /** For a check of added answers: each answer's words as weighed, hashed, by its ID. */
  weighed?: Record<string, string>;
}

interface JudgeInput {
  draft: string;
  facts: string;
  model: string;
  effort: Effort;
  prompt: string;
  /** After draft_answers: its output; absent for the draft's own check, which reads as it always did. */
  answers?: string;
}

/** The judge's latest check of the draft itself, never one of answers added to it. */
export async function draftJudgeOf(db: Db, jobId: string): Promise<StageOutput | null> {
  const { rows } = await db.query<{ output: unknown; output_hash: string }>(
    `select output, output_hash from {{schema}}.job_stage_runs
      where job_id = $1 and stage = 'judge' and outcome in ('ok', 'reused')
        and output->'answers' is null
      order by id desc limit 1`,
    [jobId],
  );
  return rows[0] ? { output: rows[0].output, outputHash: rows[0].output_hash } : null;
}

/** The judge's latest check of the answers `draft_answers` added in the run `answers` names. */
export async function answersJudgeOf(
  db: Db,
  jobId: string,
  answers: string,
): Promise<JudgeOutput | null> {
  const { rows } = await db.query<{ output: JudgeOutput }>(
    `select output from {{schema}}.job_stage_runs
      where job_id = $1 and stage = 'judge' and outcome in ('ok', 'reused')
        and output->>'answers' = $2
      order by id desc limit 1`,
    [jobId, answers],
  );
  return rows[0]?.output ?? null;
}

/**
 * The latest check of answers added to this same draft: its verdicts, and
 * the words each weighed, hashed.
 */
async function earlierAnswerCheck(db: Db, jobId: string, draftHash: string) {
  const { rows } = await db.query<{ output: JudgeOutput }>(
    `select run.output from {{schema}}.job_stage_runs as run
      where run.job_id = $1 and run.stage = 'judge' and run.outcome in ('ok', 'reused')
        and exists (
          select 1 from {{schema}}.job_stage_runs as added
           where added.job_id = $1 and added.stage = 'draft_answers'
             and added.output_hash = run.output->>'answers' and added.output->>'draft' = $2)
      order by run.id desc limit 1`,
    [jobId, draftHash],
  );
  return { verdicts: rows[0]?.output.verdicts ?? [], weighed: rows[0]?.output.weighed ?? {} };
}

const wordsHash = (text: string) => sha256Hex(text);

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
      const added = await addedAnswersOf(deps.db, ctx.job.id, draft.outputHash);
      const output = withAddedAnswers(draft.output as DraftOutput, added?.output ?? null);
      const profile = await getProfileVersion(deps.db, output.profileVersion);
      const facts = profile ? citedFacts(output.kit, profile.facts) : [];
      return {
        draft: draft.outputHash,
        facts: sha256Hex(canonicalJson(facts)),
        model: JUDGE.model,
        effort: JUDGE.effort,
        prompt: output.kit.kind === "form" ? FORM_PROMPT : JUDGE_PROMPT,
        ...(added ? { answers: added.outputHash } : {}),
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
      if (input.answers !== undefined) {
        // Only the answers added since the last check of answers added to this draft.
        const added = await addedAnswersOf(deps.db, ctx.job.id, input.draft);
        if (!added || added.outputHash !== input.answers) {
          throw new Error("judge's added answers are gone");
        }
        // A verdict stands only for the words it weighed: an answer drafted again is weighed again.
        const earlier = await earlierAnswerCheck(deps.db, ctx.job.id, input.draft);
        const words = new Map(
          added.output.answers.map((answer) => [answer.id, wordsHash(answer.text)]),
        );
        const before = earlier.verdicts.filter(
          (verdict) =>
            earlier.weighed[verdict.blockId] !== undefined &&
            earlier.weighed[verdict.blockId] === words.get(verdict.blockId),
        );
        const kept = new Set(before.map((verdict) => verdict.blockId));
        const kit: FormKit = {
          kind: "form",
          blocks: [],
          answers: added.output.answers.filter((answer) => !kept.has(answer.id)),
        };
        const output: JudgeOutput = {
          checked: true,
          verdicts: before,
          markers: [],
          answers: input.answers,
          weighed: Object.fromEntries(
            before.map((verdict) => [verdict.blockId, earlier.weighed[verdict.blockId]!]),
          ),
        };
        if (draftedAnswers(kit).length === 0) return { ok: true, output };
        const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
        const called = await callModel(deps.models, {
          stage: "judge",
          jobId: ctx.job.id,
          model: input.model,
          system: FORM_JUDGE_RULES,
          content: judgeContent(
            kit,
            citedFacts(kit, profile.facts),
            { record: extraction.record, role },
            marker,
          ),
          schema: judgeAnswerSchema,
          effort: input.effort,
          maxTokens: JUDGE.maxTokens,
        });
        if (!called.ok)
          return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };
        const fresh = mergeVerdicts(kit, called.output);
        return {
          ok: true,
          output: {
            ...output,
            verdicts: [...before, ...fresh],
            markers: [marker],
            weighed: {
              ...output.weighed,
              ...Object.fromEntries(
                fresh.map((verdict) => [verdict.blockId, words.get(verdict.blockId) ?? ""]),
              ),
            },
          },
        };
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
