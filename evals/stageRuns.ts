import { DRAFT, type DraftOutput, draftStage } from "@/core/drafting/draftStage";
import { JUDGE, type JudgeOutput, judgeStage } from "@/core/drafting/judgeStage";
import { agreement } from "@/core/extraction/addressRead";
import {
  ADDRESS_READ,
  type AddressReadOutput,
  addressReadStage,
  contactOf,
} from "@/core/extraction/addressReadStage";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { EXTRACT, extractStage, readExtractOutput } from "@/core/extraction/extract";
import { chosenRole, draftAnyway, kitByRoute, pickRole } from "@/core/extraction/owner";
import { roleKey } from "@/core/ledger/normalise";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { provisionalCost } from "@/core/platform/prices";
import { claimJob, type Pipeline, runJob, stageOutput } from "@/core/platform/runner";

import {
  budgetGuard,
  costOf,
  type EvalCase,
  estimateCase,
  jobOf,
  type RunDeps,
  UNLABELLED,
} from "./run";
import { type Proportion, sameContact, wilson } from "./score";
import { type Check, checkDraftExpectations, type SyntheticExpect } from "./synthetic";

/**
 * The evaluation runner's drafting and second-read runs (evals spec,
 * "Metrics" and "Runs, budget and reports"), each through the app's own
 * stages and runner, in a local database with the evaluation keys, until
 * the budget would be passed.
 * - `draft`: the post read, its eligibility weighed (a post the owner would
 *   have to "Draft anyway" is drafted anyway, so every case is drafted), no
 *   template drafting, as the model under test drafts each case, and the
 *   separate check after it. Scored: gap coverage, the share of must-haves
 *   short of met that a gap line answers; the separate check's verdicts; and
 *   a synthetic post's drafting expectations (its fixed answers by
 *   question, the must-have gaps the draft answers).
 * - `address_read`: the post read, and the contact's second read beside the
 *   drafting group, as the app runs it. Scored on cases whose contact a
 *   model read a second time (from a screenshot's crop): how often the
 *   second read agreed with the labelled contact, how often it caught the
 *   first read's misreading, and how often it raised a false alarm.
 */

/** How the run went for a case. */
export type Outcome = "scored" | "failed" | "budget" | "no kit" | "not read";

export interface DraftCaseResult {
  id: string;
  split: EvalCase["split"];
  route: string;
  outcome: Outcome;
  note: string | null;
  kit: string | null;
  /** The must-haves short of met: those a gap line answers, and those it does not. */
  answered: number;
  missing: number;
  /** The separate check's verdicts on the draft's blocks, by verdict. */
  verdicts: Record<string, number>;
  checks: Check[];
  costUsd: number;
  seconds: number;
}

export interface DraftingRun {
  model: string;
  budgetUsd: number;
  stoppedAtBudget: boolean;
  costUsd: number;
  cases: DraftCaseResult[];
  /** Answered must-have gaps over every must-have gap, pooled. */
  gapCoverage: Proportion;
  verdicts: Record<string, number>;
  checks: Partial<Record<keyof SyntheticExpect, Proportion>>;
}

export interface SecondReadCaseResult {
  id: string;
  split: EvalCase["split"];
  route: string;
  outcome: Outcome;
  note: string | null;
  firstRight: boolean | null;
  secondRight: boolean | null;
  agreed: boolean | null;
  costUsd: number;
  seconds: number;
}

export interface SecondReadRun {
  model: string;
  budgetUsd: number;
  stoppedAtBudget: boolean;
  costUsd: number;
  cases: SecondReadCaseResult[];
  /** The second read matching the labelled contact. */
  agreesWithLabel: Proportion;
  /** Of the first reads that were wrong, the share the second read disagreed with. */
  caught: Proportion;
  /** Of the first reads that were right, the share the second read disagreed with. */
  falseAlarms: Proportion;
}

/** The input a drafting call or a check can take at most, beyond the post's tiles: the profile and the post's fields. */
const PROMPT_ALLOWANCE_TOKENS = 12_000;
/** The crop the second read sees, at most. */
const CROP_ALLOWANCE_TOKENS = 3_000;

/** The most a case's drafting run can cost: its reading, the draft and the check, each answer at its limit. */
export async function estimateDraftCase(item: EvalCase, model: string, at: Date): Promise<number> {
  return (
    (await estimateCase(item, EXTRACT.model, at)) +
    provisionalCost(model, PROMPT_ALLOWANCE_TOKENS, DRAFT.maxTokens, at).usd +
    provisionalCost(JUDGE.model, PROMPT_ALLOWANCE_TOKENS, JUDGE.maxTokens, at).usd
  );
}

/** The most a case's second-read run can cost: its reading and the second read, each answer at its limit. */
export async function estimateSecondReadCase(
  item: EvalCase,
  model: string,
  at: Date,
): Promise<number> {
  return (
    (await estimateCase(item, EXTRACT.model, at)) +
    provisionalCost(model, CROP_ALLOWANCE_TOKENS, ADDRESS_READ.maxTokens, at).usd
  );
}

/**
 * Runs the job until it rests: at a role pick takes the labelled role, else
 * the first; at the eligibility decision drafts anyway; a post that does
 * not say how to apply rests at the kit-type pick, with no kit.
 */
async function runToRest(
  deps: RunDeps,
  pipeline: Pipeline,
  jobId: string,
  labelledRole: string | undefined,
): Promise<void> {
  const runner = { db: deps.db, clock: deps.clock, pipeline };
  for (let turn = 0; turn < 4; turn++) {
    const lease = await claimJob(runner, jobId);
    if (lease) await runJob(runner, lease);
    const state = (await loadJob(deps.db, jobId))?.state;
    if (state === "needs_role_pick") {
      const extraction = readExtractOutput((await stageOutput(deps.db, jobId, "extract"))?.output);
      const roles = extraction?.record.roles ?? [];
      const labelled =
        (labelledRole === undefined
          ? undefined
          : roles.find((role) => roleKey(role.title) === roleKey(labelledRole))) ?? roles[0];
      if (!labelled) return;
      await pickRole(deps, jobId, labelled.id);
    } else if (state === "needs_eligibility_decision") {
      await draftAnyway(deps, jobId);
    } else return;
  }
}

function modelsOf(deps: RunDeps, budgetUsd: number) {
  const budget = budgetGuard(deps.db, budgetUsd);
  const models: ModelCallDeps = {
    db: deps.db,
    clock: deps.clock,
    llmFor: deps.llmFor,
    guard: budget.guard,
  };
  return { budget, models };
}

const notRun = (item: EvalCase) => ({
  id: item.id,
  split: item.split,
  route: item.labels.route ?? UNLABELLED,
  outcome: "budget" as const,
  note: "Not run: the budget was reached.",
  costUsd: 0,
  seconds: 0,
});

/** Runs drafting on every case in turn, until the budget would be passed. */
export async function runDrafting(
  deps: RunDeps,
  cases: readonly EvalCase[],
  options: { model: string; budgetUsd: number },
): Promise<DraftingRun> {
  const { budget, models } = modelsOf(deps, options.budgetUsd);
  const pipeline: Pipeline = {
    extract: extractStage({ ...deps, models }),
    eligibility: eligibilityStage({ ...deps, kitOf: kitByRoute }),
    // The model under test drafts every case: no template drafts first.
    templates: {
      callsModel: false,
      input: () => ({}),
      run: async () => ({ ok: true as const, output: { drafts: [] } }),
      next: () => ({ state: "drafting" as const, pending: "draft" as const }),
    },
    draft: draftStage({ ...deps, models, kitOf: kitByRoute, model: options.model }),
    judge: judgeStage({ ...deps, models }),
  };
  const results: DraftCaseResult[] = [];
  for (const item of cases) {
    const empty = { kit: null, answered: 0, missing: 0, verdicts: {}, checks: [] };
    if (budget.reached()) {
      results.push({ ...notRun(item), ...empty });
      continue;
    }
    const startedAt = Date.now();
    const jobId = await jobOf(deps, item);
    await runToRest(deps, pipeline, jobId, item.labels.role);
    const base = {
      id: item.id,
      split: item.split,
      route: item.labels.route ?? UNLABELLED,
      costUsd: await costOf(deps.db, jobId),
      seconds: (Date.now() - startedAt) / 1000,
    };
    const stored = (await stageOutput(deps.db, jobId, "draft"))?.output as DraftOutput | undefined;
    const job = await loadJob(deps.db, jobId);
    if (!stored) {
      const outcome: Outcome =
        job?.state === "needs_kit_type" ? "no kit" : budget.reached() ? "budget" : "failed";
      results.push({
        ...base,
        ...empty,
        outcome,
        note:
          outcome === "no kit"
            ? "The post does not say how to apply: the owner would pick the kit."
            : (job?.failure ?? `The job rested at ${job?.state ?? "nothing"} with no draft.`),
      });
      continue;
    }
    const role = await chosenRole(deps.db, jobId);
    const must = new Set(
      (role?.requirements ?? [])
        .filter((requirement) => requirement.priority === "must")
        .map((requirement) => requirement.id),
    );
    const answeredIds = new Set<string>();
    for (const block of stored.kit.blocks) {
      for (const id of [block.gap?.requirementId ?? "", ...(block.alsoAnswers ?? [])]) {
        if (must.has(id)) answeredIds.add(id);
      }
    }
    const missing = new Set(
      stored.flags.filter((flag) => flag.kind === "missing_gap_line").map((flag) => flag.at),
    ).size;
    const judge = (await stageOutput(deps.db, jobId, "judge"))?.output as JudgeOutput | undefined;
    const verdicts: Record<string, number> = {};
    for (const verdict of judge?.checked ? judge.verdicts : []) {
      verdicts[verdict.verdict] = (verdicts[verdict.verdict] ?? 0) + 1;
    }
    results.push({
      ...base,
      outcome: "scored",
      note: job?.state === "failed" ? job.failure : null,
      kit: stored.kit.kind,
      answered: answeredIds.size,
      missing,
      verdicts,
      checks: item.expect
        ? checkDraftExpectations(item.expect, { kit: stored.kit, gapsAnswered: answeredIds.size })
        : [],
    });
  }
  const scored = results.filter((result) => result.outcome === "scored");
  const answered = scored.reduce((sum, result) => sum + result.answered, 0);
  const missing = scored.reduce((sum, result) => sum + result.missing, 0);
  const verdicts: Record<string, number> = {};
  for (const result of scored) {
    for (const [verdict, count] of Object.entries(result.verdicts)) {
      verdicts[verdict] = (verdicts[verdict] ?? 0) + count;
    }
  }
  const checkOutcomes = new Map<keyof SyntheticExpect, boolean[]>();
  for (const result of scored) {
    for (const check of result.checks) {
      if (check.met === null) continue;
      checkOutcomes.set(check.key, [...(checkOutcomes.get(check.key) ?? []), check.met]);
    }
  }
  return {
    model: options.model,
    budgetUsd: options.budgetUsd,
    stoppedAtBudget: budget.reached(),
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    cases: results,
    gapCoverage: wilson(answered, answered + missing),
    verdicts,
    checks: Object.fromEntries(
      [...checkOutcomes].map(([key, met]) => [key, wilson(met.filter(Boolean).length, met.length)]),
    ),
  };
}

/** Runs the contact's second read on every case in turn, until the budget would be passed. */
export async function runSecondRead(
  deps: RunDeps,
  cases: readonly EvalCase[],
  options: { model: string; budgetUsd: number },
): Promise<SecondReadRun> {
  const { budget, models } = modelsOf(deps, options.budgetUsd);
  const pipeline: Pipeline = {
    extract: extractStage({ ...deps, models }),
    eligibility: eligibilityStage({ ...deps, kitOf: kitByRoute }),
    // The drafting group with the second read beside it, and no draft: it rests at the kit.
    templates: {
      callsModel: false,
      input: () => ({}),
      run: async () => ({ ok: true as const, output: { drafts: [] } }),
      next: () => ({ state: "kit_ready" as const, pending: null }),
      alongside: async (ctx) =>
        contactOf(await chosenRole(deps.db, ctx.job.id)) ? ["address_read"] : [],
    },
    address_read: addressReadStage({ ...deps, models, model: options.model }),
  };
  const results: SecondReadCaseResult[] = [];
  for (const item of cases) {
    const empty = { firstRight: null, secondRight: null, agreed: null };
    if (budget.reached()) {
      results.push({ ...notRun(item), ...empty });
      continue;
    }
    const startedAt = Date.now();
    const jobId = await jobOf(deps, item);
    await runToRest(deps, pipeline, jobId, item.labels.role);
    const base = {
      id: item.id,
      split: item.split,
      route: item.labels.route ?? UNLABELLED,
      costUsd: await costOf(deps.db, jobId),
      seconds: (Date.now() - startedAt) / 1000,
    };
    const read = (await stageOutput(deps.db, jobId, "address_read"))?.output as
      AddressReadOutput | undefined;
    const contact = contactOf(await chosenRole(deps.db, jobId));
    const label = item.labels.contact;
    if (!read?.checked || !contact || !("read" in read.second) || label === undefined) {
      const job = await loadJob(deps.db, jobId);
      results.push({
        ...base,
        ...empty,
        outcome: budget.reached() ? "budget" : "not read",
        note: !contact
          ? "No email address or WhatsApp number was read."
          : label === undefined
            ? "The case labels no contact."
            : read?.checked
              ? "The contact was settled without a model's second read (pasted text, or no crop)."
              : (job?.failure ?? "The second read did not run."),
      });
      continue;
    }
    const firstRight = sameContact(contact.contact, label);
    results.push({
      ...base,
      outcome: "scored",
      note: null,
      firstRight,
      secondRight: read.second.read !== null && sameContact(read.second.read, label),
      agreed: agreement(contact.kind, contact.contact, read.second).ok,
    });
  }
  const scored = results.filter((result) => result.outcome === "scored");
  const wrongFirst = scored.filter((result) => result.firstRight === false);
  const rightFirst = scored.filter((result) => result.firstRight === true);
  return {
    model: options.model,
    budgetUsd: options.budgetUsd,
    stoppedAtBudget: budget.reached(),
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    cases: results,
    agreesWithLabel: wilson(scored.filter((result) => result.secondRight).length, scored.length),
    caught: wilson(wrongFirst.filter((result) => !result.agreed).length, wrongFirst.length),
    falseAlarms: wilson(rightFirst.filter((result) => !result.agreed).length, rightFirst.length),
  };
}
