import { z } from "zod";

import { readExtractOutput } from "@/core/extraction/extract";
import { chosenRole } from "@/core/extraction/owner";
import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";
import { SKILLS } from "@/core/shared/skills";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import { acceptedInstructions, buildFormKit, oneLine } from "./build";
import {
  BUILD_VERSION,
  DRAFT,
  type DraftOutput,
  FORM_BUILD,
  NO_PROFILE,
  withoutAiLines,
} from "./draftStage";
import { type FormAnswer, formAnswerSchema, type FormKit } from "./kit";
import { ANSWERS_LAYOUT_VERSION, answersContent, answersSystemPrompt } from "./prompt";
import { TOPICS } from "./topics";
import { type KitFlag, validateKit } from "./validate";

/**
 * The `draft_answers` stage (drafting spec, "Stage draft_answers"): after
 * `extract_questions` added questions to a form whose kit exists, one call
 * on the draft's model answers only the new questions, with the same inputs
 * and rules as the form's draft, and code fills the topic answers. Existing
 * blocks, answers, verdicts and the owner's edits are untouched: the new
 * answers are kept apart, after the kit's, and the kit as the page shows it
 * is the draft's with them (`withAddedAnswers`). The output keeps every
 * answer added to this draft so far. No call is made when no new question
 * may reach the drafter (each addressed to AI, or repeating a line aimed at
 * AI).
 */

/** The drafter's answers to the new questions alone: the form's schema without its fit and note. */
export const answersOnlySchema = z.object({ answers: formAnswerSchema.shape.answers });

// The prompt as sent, and the form's build, which fills the topic answers.
const ANSWERS_PROMPT = sha256Hex(
  canonicalJson({
    kit: "form",
    answersOnly: true,
    rules: answersSystemPrompt(),
    layout: ANSWERS_LAYOUT_VERSION,
    schema: z.toJSONSchema(answersOnlySchema),
    build: BUILD_VERSION,
    formBuild: FORM_BUILD,
    skills: SKILLS,
    topics: TOPICS,
  }),
);

const PASSING: ReadonlySet<ModelCallFailure> = new Set(["timeout", "unavailable"]);

/** What `draft_answers` keeps: the answers added to one draft, and validate's flags on the kit with them. */
export interface AddedAnswers {
  /** The `draft` output the answers add to. */
  draft: string;
  answers: FormAnswer[];
  /** validate's flags on the whole kit with every added answer. */
  flags: KitFlag[];
  /** Every call's marker string, for reference_leak. */
  markers: string[];
}

const addedAnswersSchema = z.object({
  draft: z.string(),
  answers: z.array(z.looseObject({ id: z.string() })),
  flags: z.array(z.looseObject({ kind: z.string() })),
  markers: z.array(z.string()),
});

/** draft_answers' stored output, or null when it is not one this version can read. */
export function readAddedAnswers(output: unknown): AddedAnswers | null {
  return addedAnswersSchema.safeParse(output).success ? (output as AddedAnswers) : null;
}

/**
 * The answers added to a draft, as the job's latest `draft_answers` run
 * keeps them, with that run's output hash; null when it added to another
 * draft, or none ran.
 */
export async function addedAnswersOf(
  db: Db,
  jobId: string,
  draftHash: string,
): Promise<{ output: AddedAnswers; outputHash: string } | null> {
  const { rows } = await db.query<{ output: unknown; output_hash: string }>(
    `select output, output_hash from {{schema}}.job_stage_runs
      where job_id = $1 and stage = 'draft_answers' and outcome in ('ok', 'reused')
      order by id desc limit 1`,
    [jobId],
  );
  const added = readAddedAnswers(rows[0]?.output);
  return added && added.draft === draftHash
    ? { output: added, outputHash: rows[0]!.output_hash }
    : null;
}

/** The draft as the page reads it: the form's answers with those added since after them, and their flags. */
export function withAddedAnswers(draft: DraftOutput, added: AddedAnswers | null): DraftOutput {
  if (!added || draft.kit.kind !== "form") return draft;
  return {
    ...draft,
    kit: { ...draft.kit, answers: [...draft.kit.answers, ...added.answers] },
    flags: added.flags,
    markers: [...draft.markers, ...added.markers],
  };
}

interface AnswersInput {
  draft: string;
  /** Every question added to the draft, on one line, and whether each addresses AI. */
  questions: { id: string; text: string; ai: boolean }[];
  profile: string;
  model: string;
  effort: Effort;
  prompt: string;
}

export interface AnswersDeps {
  db: Db;
  random: Random;
  models: ModelCallDeps;
}

export function draftAnswersStage(deps: AnswersDeps): StageDefinition {
  /** The draft, the answers added to it so far, and the role with every question added. */
  async function parts(ctx: Parameters<StageDefinition["input"]>[0]) {
    const stored = await ctx.outputOf("draft");
    const role = await chosenRole(deps.db, ctx.job.id);
    if (!stored || !role) throw new Error("draft_answers runs only after draft, on a chosen role");
    const draft = stored.output as DraftOutput;
    if (draft.kit.kind !== "form") throw new Error("draft_answers adds to a form's kit alone");
    const earlier = await addedAnswersOf(deps.db, ctx.job.id, stored.outputHash);
    const answered = new Set(
      [...draft.kit.answers, ...(earlier?.output.answers ?? [])].map((answer) => answer.id),
    );
    const fresh = role.screening_questions.filter((question) => !answered.has(question.id));
    // Every question added to the draft, answered or not: what the stage's output answers.
    const ownIds = new Set(draft.kit.answers.map((answer) => answer.id));
    const added = role.screening_questions.filter((question) => !ownIds.has(question.id));
    return { draftHash: stored.outputHash, draft, kit: draft.kit, earlier, role, fresh, added };
  }

  return {
    callsModel: true,

    // B9: the IDs and texts of the questions added (every one, so an output kept for fewer is
    // never taken for more), the draft they add to, the profile version, the model's settings.
    async input(ctx): Promise<AnswersInput> {
      const { draftHash, draft, added } = await parts(ctx);
      return {
        draft: draftHash,
        questions: added.map((question) => ({
          id: question.id,
          text: oneLine(question.text),
          ai: question.addressed_to_ai,
        })),
        profile: draft.profileVersion,
        model: DRAFT.model,
        effort: DRAFT.effort,
        prompt: ANSWERS_PROMPT,
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as AnswersInput;
      const { draft, kit, earlier, role, fresh } = await parts(ctx);
      const profile = await getProfileVersion(deps.db, input.profile);
      if (!profile) return { ok: false, reason: NO_PROFILE, retry: false };
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      if (!extraction) throw new Error("draft_answers' record is gone");
      // The record with the role's added questions, so a new question addressed to AI holds back
      // any other that repeats it, as the draft's own do.
      const record = {
        ...extraction.record,
        roles: extraction.record.roles.map((each) => (each.id === role.id ? role : each)),
      };
      const accepted = acceptedInstructions(role);
      const post = withoutAiLines(record, role, accepted.keyword);
      const freshIds = new Set(fresh.map((question) => question.id));
      const shown = post.role.screening_questions.filter((question) => freshIds.has(question.id));
      const markers: string[] = [];
      let drafted: z.output<typeof answersOnlySchema>["answers"] = [];
      if (shown.length > 0) {
        const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
        markers.push(marker);
        const called = await callModel(deps.models, {
          stage: "draft_answers",
          jobId: ctx.job.id,
          model: input.model,
          system: answersSystemPrompt(),
          content: answersContent(
            profile,
            { company: post.company, role: { ...post.role, screening_questions: shown } },
            marker,
          ),
          schema: answersOnlySchema,
          effort: input.effort,
          maxTokens: DRAFT.maxTokens,
        });
        if (!called.ok)
          return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };
        drafted = called.output.answers;
      }
      const shownIds = new Set(shown.map((question) => question.id));
      const profileParts = {
        facts: profile.facts,
        knownGaps: profile.knownGaps,
        gapTemplates: profile.gapTemplates,
      };
      const built = buildFormKit(
        { fit: [], blocks: [], answers: drafted },
        {
          role: { ...role, screening_questions: fresh },
          profile: profileParts,
          topics: { home: profile.owner.location.country, answers: profile.fixedAnswers },
          // The questions the drafter was not shown, as they repeat a line aimed at AI.
          held: new Set(
            fresh.filter((question) => !shownIds.has(question.id)).map((question) => question.id),
          ),
        },
      );
      const answers = [...(earlier?.output.answers ?? []), ...(built.kit as FormKit).answers];
      const allMarkers = [...(earlier?.output.markers ?? []), ...markers];
      const whole: FormKit = { ...kit, answers: [...kit.answers, ...answers] };
      const flags = validateKit(whole, {
        record,
        role,
        profile: profileParts,
        fit: draft.fit,
        wordLimit: draft.wordLimit,
        keyword: draft.keyword,
        subjectFormat: draft.subjectFormat,
        markers: [...draft.markers, ...allMarkers],
      });
      const output: AddedAnswers = { draft: input.draft, answers, flags, markers: allMarkers };
      return { ok: true, output };
    },

    next(): Transition {
      return { state: "judging", pending: "judge" };
    },
  };
}
