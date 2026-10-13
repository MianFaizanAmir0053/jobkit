import { createHash } from "node:crypto";

import sharp from "sharp";

import type { EligibilityOutput } from "@/core/extraction/eligibility";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { EXTRACT, extractStage, readExtractOutput, stopReasonOf } from "@/core/extraction/extract";
import { chosenRole, pickRole } from "@/core/extraction/owner";
import { extractSystemPrompt } from "@/core/extraction/prompt";
import { confirmUploads, startJob } from "@/core/intake/jobs";
import type { ImageMeta } from "@/core/intake/limits";
import { roleKey } from "@/core/ledger/normalise";
import { loadJob } from "@/core/platform/jobs";
import {
  estimateInputTokens,
  type ModelCallDeps,
  type ModelCallGuard,
} from "@/core/platform/models";
import { provisionalCost } from "@/core/platform/prices";
import { claimJob, type Pipeline, runJob, stageOutput } from "@/core/platform/runner";
import type { Clock, Db, Llm, LlmInput, Random, Storage } from "@/core/ports";
import { MAX_LONG_EDGE, tileCount } from "@/core/shared/tileGeometry";

import {
  type FieldMatches,
  fieldMatches,
  type Proportion,
  SCORED_FIELDS,
  type ScoredFields,
  wilson,
} from "./score";
import type { Split } from "./split";
import { type Check, checkExpectations, type SyntheticExpect } from "./synthetic";

/**
 * The evaluation runner's extraction runs (evals spec, "Runs, budget and
 * reports"): the app's own stages, `extract` and then `eligibility`, run on
 * each labelled case through the app's runner, in a local database with the
 * evaluation keys, and scored against the owner's labels, or against a
 * synthetic post's expectations, with the checks on what the model noticed.
 * A post with several roles goes on with the labelled one, as the owner
 * would pick it, else the first. A guard stops the run before any model
 * call that could take it past its budget; the case that met the budget is
 * not scored.
 */

export type ImageType = ImageMeta["contentType"];

/** An archive split, or the public synthetic posts. */
export type CaseSplit = Split | "synthetic";

/** A case as the runner takes it: the post's screenshots or pasted text, and what is expected of it. */
export interface EvalCase {
  id: string;
  split: CaseSplit;
  images: { bytes: Uint8Array; contentType: ImageType }[];
  pastedText: string;
  /** The labelled fields, each scored: all of them for an archive case, those it gives for a synthetic post. */
  labels: Partial<ScoredFields>;
  /** A synthetic post's expectations, checked on what the model noticed. */
  expect?: SyntheticExpect;
}

/** The route a case without one is pooled under. */
const UNLABELLED = "unlabelled";

export interface RunDeps {
  /** A local database, migrated, with the profile seeded; nothing else is written. */
  db: Db;
  storage: Storage;
  clock: Clock;
  random: Random;
  llmFor(model: string): Llm;
}

export interface CaseResult {
  id: string;
  split: CaseSplit;
  /** The labelled route, by which results are also pooled; "unlabelled" for a post that gives none. */
  route: string;
  /** Scored, or why not: the job failed, or the budget ran out first. */
  outcome: "scored" | "failed" | "budget";
  /** What stopped the post or failed the job, when either did. */
  note: string | null;
  extracted: ScoredFields | null;
  matches: FieldMatches | null;
  /** A scored synthetic post's checks; none for an archive case. */
  checks: Check[];
  costUsd: number;
  seconds: number;
}

export type FieldMetrics = Record<
  keyof ScoredFields,
  { pooled: Proportion; byRoute: Record<string, Proportion> }
>;

/** Each check's share met, over the scored posts that expect it and the stage checks. */
export type CheckMetrics = Partial<Record<keyof SyntheticExpect, Proportion>>;

export interface ExtractionRun {
  model: string;
  budgetUsd: number;
  stoppedAtBudget: boolean;
  costUsd: number;
  cases: CaseResult[];
  metrics: FieldMetrics;
  checks: CheckMetrics;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A screenshot as the phone would send it: no wider than 2,576 pixels, upright. */
async function asSent(image: EvalCase["images"][number]) {
  const { width = 0, height = 0, orientation } = await sharp(image.bytes).metadata();
  if (width <= MAX_LONG_EDGE && (orientation ?? 1) === 1) {
    return { bytes: image.bytes, contentType: image.contentType, width, height };
  }
  const { data, info } = await sharp(image.bytes)
    .autoOrient()
    .resize({ width: MAX_LONG_EDGE, withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(data),
    contentType: "image/png" as const,
    width: info.width,
    height: info.height,
  };
}

/** The most one case's extraction can cost: each tile at its highest token count, the answer at its limit. */
export async function estimateCase(item: EvalCase, model: string, at: Date): Promise<number> {
  const content: LlmInput[] = [{ type: "text", text: item.pastedText }];
  for (const image of item.images) {
    const sent = await asSent(image);
    for (let tile = 0; tile < tileCount(sent.width, sent.height); tile++) {
      content.push({ type: "image", mediaType: "image/png", base64: "" });
    }
  }
  const inputTokens = estimateInputTokens({ system: extractSystemPrompt(false), content });
  return provisionalCost(model, inputTokens, EXTRACT.maxTokens, at).usd;
}

/** What this run has spent in its local database, and a guard refusing any call that could pass the budget. */
function budgetGuard(db: Db, budgetUsd: number) {
  let reached = false;
  const guard: ModelCallGuard = async ({ provisionalCostUsd }) => {
    const { rows } = await db.query<{ spent: string | number }>(
      "select coalesce(sum(cost_usd), 0) as spent from {{schema}}.model_calls",
    );
    const spent = Number(rows[0]?.spent ?? 0);
    if (spent + provisionalCostUsd <= budgetUsd) return { ok: true };
    reached = true;
    return {
      ok: false,
      message: `The run's budget of $${budgetUsd.toFixed(2)} would be passed: $${spent.toFixed(2)} spent so far.`,
    };
  };
  return { guard, reached: () => reached };
}

async function costOf(db: Db, jobId: string): Promise<number> {
  const { rows } = await db.query<{ cost: string | number }>(
    "select coalesce(sum(cost_usd), 0) as cost from {{schema}}.model_calls where job_id = $1",
    [jobId],
  );
  return Number(rows[0]?.cost ?? 0);
}

/** A new job holding the case's screenshots and pasted text, as intake leaves one. */
async function jobOf(deps: RunDeps, item: EvalCase): Promise<string> {
  const images = await Promise.all(item.images.map(asSent));
  const metas: ImageMeta[] = images.map((image) => ({
    contentType: image.contentType,
    bytes: image.bytes.length,
    width: image.width,
    height: image.height,
    sha256: sha256(image.bytes),
  }));
  const started = await startJob(deps, {
    images: metas,
    pastedText: item.pastedText,
    clientElapsedMs: 0,
  });
  if (!started.ok) throw new Error(started.message);
  const { rows } = await deps.db.query<{ storage_path: string }>(
    "select storage_path from {{schema}}.job_images where job_id = $1 order by position",
    [started.jobId],
  );
  for (const [i, row] of rows.entries()) {
    await deps.storage.put(row.storage_path, images[i]!.bytes, images[i]!.contentType);
  }
  if (images.length > 0) {
    const confirmed = await confirmUploads(deps, started.jobId);
    if (!confirmed.ok) throw new Error(confirmed.reason);
  }
  return started.jobId;
}

/** Runs the job until it waits for the owner or stops; at a role pick, takes the labelled role, else the first. */
async function runToEnd(
  deps: RunDeps,
  pipeline: Pipeline,
  jobId: string,
  labelledRole: string | undefined,
): Promise<void> {
  const runner = { db: deps.db, clock: deps.clock, pipeline };
  for (let turn = 0; turn < 2; turn++) {
    const lease = await claimJob(runner, jobId);
    if (lease) await runJob(runner, lease);
    if ((await loadJob(deps.db, jobId))?.state !== "needs_role_pick") return;
    const extraction = readExtractOutput((await stageOutput(deps.db, jobId, "extract"))?.output);
    const roles = extraction?.record.roles ?? [];
    const labelled =
      (labelledRole === undefined
        ? undefined
        : roles.find((role) => roleKey(role.title) === roleKey(labelledRole))) ?? roles[0];
    if (!labelled) return;
    await pickRole(deps, jobId, labelled.id);
  }
}

async function runCase(
  deps: RunDeps,
  pipeline: Pipeline,
  item: EvalCase,
  budget: { reached: () => boolean },
): Promise<CaseResult> {
  const startedAt = Date.now();
  const result = (
    outcome: CaseResult["outcome"],
    rest: Pick<CaseResult, "note" | "extracted" | "matches" | "checks" | "costUsd">,
  ): CaseResult => ({
    id: item.id,
    split: item.split,
    route: item.labels.route ?? UNLABELLED,
    outcome,
    ...rest,
    seconds: (Date.now() - startedAt) / 1000,
  });
  const jobId = await jobOf(deps, item);
  await runToEnd(deps, pipeline, jobId, item.labels.role);
  const costUsd = await costOf(deps.db, jobId);
  const extraction = readExtractOutput((await stageOutput(deps.db, jobId, "extract"))?.output);
  if (!extraction) {
    const failure = (await loadJob(deps.db, jobId))?.failure ?? "The extraction gave no record.";
    return result(budget.reached() ? "budget" : "failed", {
      note: failure,
      extracted: null,
      matches: null,
      checks: [],
      costUsd,
    });
  }
  const role = stopReasonOf(extraction) === null ? await chosenRole(deps.db, jobId) : null;
  const eligibility = (await stageOutput(deps.db, jobId, "eligibility"))?.output as
    EligibilityOutput | undefined;
  const extracted: ScoredFields = {
    company: extraction.record.company.name,
    role: role?.title ?? "",
    route: role?.route.kind ?? "",
    contact: role?.route.address ?? "",
    eligibility: eligibility?.checked ? eligibility.result : "",
  };
  const matches = fieldMatches(extracted, item.labels);
  // With no role read, nothing about one is right, even a contact both leave empty.
  if (!role) {
    for (const field of SCORED_FIELDS) {
      if (field !== "company" && matches[field] !== undefined) matches[field] = false;
    }
  }
  const stop = stopReasonOf(extraction);
  return result("scored", {
    note: stop ? `The post stopped: ${stop}.` : null,
    extracted,
    matches,
    checks: item.expect ? checkExpectations(item.expect, { output: extraction, role }) : [],
    costUsd,
  });
}

/**
 * Each field's share right over the scored cases that label it, pooled and
 * by the labelled route, with intervals.
 */
export function metricsOf(results: readonly CaseResult[]): FieldMetrics {
  const scored = results.filter((result) => result.outcome === "scored");
  const routes = [...new Set(scored.map((result) => result.route))].sort();
  const shareOf = (field: keyof ScoredFields, cases: readonly CaseResult[]) => {
    const judged = cases.filter((result) => result.matches?.[field] !== undefined);
    return wilson(judged.filter((result) => result.matches![field]).length, judged.length);
  };
  return Object.fromEntries(
    SCORED_FIELDS.map((field) => [
      field,
      {
        pooled: shareOf(field, scored),
        byRoute: Object.fromEntries(
          routes.map((route) => [
            route,
            shareOf(
              field,
              scored.filter((result) => result.route === route),
            ),
          ]),
        ),
      },
    ]),
  ) as FieldMetrics;
}

/** Each check's share met over the scored posts that expect it; a check left to a later stage counts in none. */
export function checkMetricsOf(results: readonly CaseResult[]): CheckMetrics {
  const outcomes = new Map<keyof SyntheticExpect, boolean[]>();
  for (const result of results.filter((each) => each.outcome === "scored")) {
    for (const check of result.checks) {
      if (check.met === null) continue;
      outcomes.set(check.key, [...(outcomes.get(check.key) ?? []), check.met]);
    }
  }
  return Object.fromEntries(
    [...outcomes].map(([key, met]) => [key, wilson(met.filter(Boolean).length, met.length)]),
  );
}

/** Runs extraction on every case in turn, until the budget would be passed. */
export async function runExtraction(
  deps: RunDeps,
  cases: readonly EvalCase[],
  options: { model: string; budgetUsd: number },
): Promise<ExtractionRun> {
  const budget = budgetGuard(deps.db, options.budgetUsd);
  const models: ModelCallDeps = {
    db: deps.db,
    clock: deps.clock,
    llmFor: deps.llmFor,
    guard: budget.guard,
  };
  const pipeline: Pipeline = {
    extract: extractStage({ ...deps, models, model: options.model }),
    eligibility: eligibilityStage(deps),
  };
  const results: CaseResult[] = [];
  for (const item of cases) {
    if (budget.reached()) {
      results.push({
        id: item.id,
        split: item.split,
        route: item.labels.route ?? UNLABELLED,
        outcome: "budget",
        note: "Not run: the budget was reached.",
        extracted: null,
        matches: null,
        checks: [],
        costUsd: 0,
        seconds: 0,
      });
      continue;
    }
    results.push(await runCase(deps, pipeline, item, budget));
  }
  return {
    model: options.model,
    budgetUsd: options.budgetUsd,
    stoppedAtBudget: budget.reached(),
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    cases: results,
    metrics: metricsOf(results),
    checks: checkMetricsOf(results),
  };
}
