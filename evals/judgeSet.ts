import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { JUDGE_RULES, judgeAnswerSchema, judgeContent, mergeVerdicts } from "@/core/drafting/judge";
import { JUDGE } from "@/core/drafting/judgeStage";
import type { EmailKit } from "@/core/drafting/kit";
import type { JobRecord, Role } from "@/core/extraction/record";
import {
  callModel,
  estimateInputTokens,
  type ModelCallDeps,
  type ModelCallGuard,
} from "@/core/platform/models";
import { provisionalCost } from "@/core/platform/prices";
import type { Clock, Db, Llm, Random } from "@/core/ports";
import { type Fact, factSchema } from "@/core/profile/schema";

import {
  compareModels,
  type Comparison,
  type PrecisionRecall,
  precisionRecall,
  type Proportion,
  wilson,
} from "./score";

/**
 * The frozen judge set (evals spec, "Labelling" and "Metrics"): sentences
 * Claude Code drafted against the real profile's facts, at least 40 meant
 * as overstated or unsupported and 40 as supported, each with the facts it
 * cites frozen as they read then, so results stay comparable across prompt,
 * model and profile changes. The owner labels each once, blind to any
 * verdict, Claude Code's intent included. The run gives the judge each
 * sentence alone, as one claim of an email, through the app's own prompt,
 * and scores its "not supported" calls (overstated or unsupported) against
 * the labels: precision and recall with their intervals, and two models
 * compared with McNemar's exact test on the sentences where one alone was
 * right. The set lives in private/evals/judge-set.json, written whole, its
 * last good copy beside it, and never changes once made but for the labels.
 */

export const JUDGE_LABELS = ["supported", "not_supported"] as const;
export type JudgeLabel = (typeof JUDGE_LABELS)[number];

/** At least this many sentences meant each way (evals spec). */
export const MIN_EACH = 40;

const itemSchema = z.strictObject({
  id: z.string().regex(/^J\d{2,3}$/),
  sentence: z.string().min(1),
  facts: z.array(factSchema).min(1),
  intent: z.enum(JUDGE_LABELS),
  label: z.enum(JUDGE_LABELS).nullable(),
  labelledAt: z.string().nullable(),
});

const setSchema = z.strictObject({
  createdAt: z.string(),
  items: z.array(itemSchema),
});

export type JudgeSetItem = z.output<typeof itemSchema>;
export type JudgeSet = z.output<typeof setSchema>;

/** A sentence as the labelling page shows it: never what it was meant to be. */
export type LabellingItem = Omit<JudgeSetItem, "intent">;

/** A candidate as Claude Code drafts it: the sentence, the facts it cites by ID, and what it is meant to be. */
export interface Candidate {
  sentence: string;
  factIds: string[];
  intent: JudgeLabel;
}

/** The set in its file; null when there is none yet. A file that cannot be read stops the caller. */
export function readJudgeSet(file: string): JudgeSet | null {
  if (!existsSync(file)) return null;
  const parsed = setSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`${file} is not a judge set this version can read: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Writes the set whole, through a file beside it, then keeps a copy of the last good one. */
function writeJudgeSet(file: string, set: JudgeSet): void {
  const next = `${file}.next`;
  writeFileSync(next, `${JSON.stringify(setSchema.parse(set), null, 2)}\n`);
  renameSync(next, file);
  copyFileSync(file, `${file}.bak`);
}

/**
 * Makes the set from Claude Code's candidates and the profile's approved
 * facts, each cited fact frozen whole. Refused when a set exists, as it
 * never changes, when a candidate cites a fact the profile does not hold
 * approved, or with fewer than MIN_EACH meant each way.
 */
export function createJudgeSet(
  file: string,
  candidates: readonly Candidate[],
  facts: readonly Fact[],
  at: Date,
): JudgeSet {
  if (existsSync(file)) throw new Error(`${file} exists: the judge set never changes once made.`);
  const approved = new Map(facts.filter((fact) => fact.approved).map((fact) => [fact.id, fact]));
  for (const label of JUDGE_LABELS) {
    const count = candidates.filter((candidate) => candidate.intent === label).length;
    if (count < MIN_EACH) {
      throw new Error(
        `The set needs at least ${MIN_EACH} sentences meant ${label}; it has ${count}.`,
      );
    }
  }
  const items = candidates.map((candidate, i): JudgeSetItem => {
    const cited = candidate.factIds.map((id) => {
      const fact = approved.get(id);
      if (!fact) throw new Error(`Candidate ${i + 1} cites ${id}, which is no approved fact.`);
      return fact;
    });
    return {
      id: `J${String(i + 1).padStart(2, "0")}`,
      sentence: candidate.sentence.trim(),
      facts: cited,
      intent: candidate.intent,
      label: null,
      labelledAt: null,
    };
  });
  const set: JudgeSet = { createdAt: at.toISOString(), items };
  writeJudgeSet(file, set);
  return set;
}

/** The sentences as the labelling page shows them, without what Claude Code meant each to be. */
export function forLabelling(set: JudgeSet): LabellingItem[] {
  return set.items.map(({ id, sentence, facts, label, labelledAt }) => ({
    id,
    sentence,
    facts,
    label,
    labelledAt,
  }));
}

/** Labels one sentence, once: a label never changes, so the set stays what the owner judged blind. */
export function labelJudgeItem(
  file: string,
  id: string,
  label: JudgeLabel,
  at: Date,
): { ok: true } | { ok: false; reason: "no-set" | "not-found" | "labelled" } {
  const set = readJudgeSet(file);
  if (!set) return { ok: false, reason: "no-set" };
  const item = set.items.find((each) => each.id === id);
  if (!item) return { ok: false, reason: "not-found" };
  if (item.label !== null) return { ok: false, reason: "labelled" };
  writeJudgeSet(file, {
    ...set,
    items: set.items.map((each) =>
      each.id === id ? { ...each, label, labelledAt: at.toISOString() } : each,
    ),
  });
  return { ok: true };
}

/** The post the judge's prompt names: none of its fields is cited, so a stand-in serves. */
const STAND_IN_ROLE: Role = {
  id: "P1",
  title: "Engineer",
  seniority: "unspecified",
  employment: "unspecified",
  location: {
    work_mode: "unspecified",
    places: [],
    remote_regions: [],
    time_zone: { zone: "unspecified", min_overlap_hours: -1, text: "" },
  },
  eligibility: { work_authorisation: [], sponsorship: "unspecified", other_limits: [] },
  salary: { text: "", currency: "", min: -1, max: -1, period: "unspecified" },
  requirements: [],
  route: {
    kind: "email",
    address: "",
    quote: "",
    box: { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 },
  },
  instructions: [],
  required_attachments: [],
  screening_questions: [],
} as unknown as Role;

const STAND_IN_RECORD = {
  post_kind: "job_post",
  language: "en",
  company: { name: "", website: "" },
  recruiter: { name: "", title: "" },
  scam_signals: [],
  roles: [STAND_IN_ROLE],
} as unknown as JobRecord;

/** The sentence as the judge sees it: an email's one claim, citing its facts. */
function kitOf(item: JudgeSetItem): EmailKit {
  return {
    kind: "email",
    subject: "",
    greeting: "",
    closing: "",
    blocks: [
      {
        id: "S1",
        text: item.sentence,
        paragraphBreak: false,
        class: "claim",
        factIds: item.facts.map((fact) => fact.id),
        fields: [],
        gap: null,
      },
    ],
  };
}

export interface JudgeSetDeps {
  /** A local database: only the run's model calls are logged in it. */
  db: Db;
  clock: Clock;
  random: Random;
  llmFor(model: string): Llm;
}

export interface JudgeSetResult {
  id: string;
  label: JudgeLabel;
  outcome: "scored" | "failed" | "budget";
  /** The judge's verdict, and its note; none unless scored. */
  verdict: string | null;
  note: string | null;
  /** Whether the judge called it not supported (overstated or unsupported). */
  notSupported: boolean | null;
  right: boolean | null;
  costUsd: number;
  seconds: number;
}

export interface JudgeSetRun {
  model: string;
  budgetUsd: number;
  stoppedAtBudget: boolean;
  costUsd: number;
  items: JudgeSetResult[];
  /** "Not supported" against the labels. */
  notSupported: PrecisionRecall;
  /** The share of sentences the judge called as the owner did. */
  accuracy: Proportion;
}

/** The most one sentence's check can cost: its prompt as sent, the answer at its limit. */
export function estimateJudgeItem(item: JudgeSetItem, model: string, at: Date): number {
  const content = judgeContent(
    kitOf(item),
    item.facts,
    { record: STAND_IN_RECORD, role: STAND_IN_ROLE },
    "0".repeat(32),
  );
  const inputTokens = estimateInputTokens({ system: JUDGE_RULES, content });
  return provisionalCost(model, inputTokens, JUDGE.maxTokens, at).usd;
}

/** A guard refusing any call that could take the run past its budget, as extraction's runs keep it. */
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

/** Runs the judge on every labelled sentence in turn, until the budget would be passed. */
export async function runJudgeSet(
  deps: JudgeSetDeps,
  set: JudgeSet,
  options: { model: string; budgetUsd: number },
): Promise<JudgeSetRun> {
  const budget = budgetGuard(deps.db, options.budgetUsd);
  const models: ModelCallDeps = {
    db: deps.db,
    clock: deps.clock,
    llmFor: deps.llmFor,
    guard: budget.guard,
  };
  const spent = async () => {
    const { rows } = await deps.db.query<{ spent: string | number }>(
      "select coalesce(sum(cost_usd), 0) as spent from {{schema}}.model_calls",
    );
    return Number(rows[0]?.spent ?? 0);
  };
  const items: JudgeSetResult[] = [];
  for (const item of set.items) {
    if (item.label === null) continue;
    const startedAt = Date.now();
    const before = await spent();
    const base = { id: item.id, label: item.label, costUsd: 0, seconds: 0 };
    if (budget.reached()) {
      items.push({
        ...base,
        outcome: "budget",
        verdict: null,
        note: null,
        notSupported: null,
        right: null,
      });
      continue;
    }
    const kit = kitOf(item);
    const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
    const called = await callModel(models, {
      stage: "judge",
      jobId: null,
      model: options.model,
      system: JUDGE_RULES,
      content: judgeContent(
        kit,
        item.facts,
        { record: STAND_IN_RECORD, role: STAND_IN_ROLE },
        marker,
      ),
      schema: judgeAnswerSchema,
      effort: JUDGE.effort,
      maxTokens: JUDGE.maxTokens,
    });
    const costUsd = (await spent()) - before;
    const seconds = (Date.now() - startedAt) / 1000;
    if (!called.ok) {
      items.push({
        ...base,
        outcome: budget.reached() ? "budget" : "failed",
        verdict: null,
        note: called.message,
        notSupported: null,
        right: null,
        costUsd,
        seconds,
      });
      continue;
    }
    const verdict = mergeVerdicts(kit, called.output)[0]!;
    const notSupported = verdict.verdict === "overstated" || verdict.verdict === "unsupported";
    items.push({
      ...base,
      outcome: "scored",
      verdict: verdict.verdict,
      note: verdict.note || null,
      notSupported,
      right: notSupported === (item.label === "not_supported"),
      costUsd,
      seconds,
    });
  }
  const scored = items.filter((each) => each.outcome === "scored");
  return {
    model: options.model,
    budgetUsd: options.budgetUsd,
    stoppedAtBudget: budget.reached(),
    costUsd: items.reduce((sum, each) => sum + each.costUsd, 0),
    items,
    notSupported: precisionRecall(
      scored.map((each) => ({
        predicted: each.notSupported!,
        actual: each.label === "not_supported",
      })),
    ),
    accuracy: wilson(scored.filter((each) => each.right).length, scored.length),
  };
}

/** Two runs on the judge set compared on the sentences both scored: McNemar's exact test. */
export function compareJudgeRuns(first: JudgeSetRun, second: JudgeSetRun): Comparison {
  const other = new Map(
    second.items.filter((each) => each.outcome === "scored").map((each) => [each.id, each]),
  );
  const rows = first.items.flatMap((each) => {
    const match = other.get(each.id);
    return each.outcome === "scored" && match ? [{ first: each.right!, second: match.right! }] : [];
  });
  return compareModels(rows);
}

export interface JudgeSetReport extends JudgeSetRun {
  stage: "judge-set";
  startedAt: string;
  finishedAt: string;
  commit: string;
  /** The judge's prompt version, as its stage hashes it. */
  prompt: string;
  effort: string;
}

const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);
const shareText = (share: Proportion) =>
  `${share.successes} of ${share.n} (${percent(share.point)}, ${percent(share.low)} to ${percent(share.high)})`;

/** The judge set's report: "not supported" against the labels, with intervals, and each sentence's call. */
export function judgeReportMarkdown(report: JudgeSetReport): string {
  const count = (outcome: JudgeSetResult["outcome"]) =>
    report.items.filter((each) => each.outcome === outcome).length;
  const { notSupported } = report;
  const cell = (text: string) => text.replaceAll("|", "/").replaceAll("\n", " ");
  return `${[
    `# judge-set, ${report.model}`,
    "",
    `Run at ${report.startedAt}, commit ${report.commit.slice(0, 12)}, prompt ${report.prompt.slice(0, 12)}, effort ${report.effort}.`,
    `Sentences: ${count("scored")} scored, ${count("failed")} failed, ${count("budget")} not run for the budget. Cost $${report.costUsd.toFixed(2)} of a $${report.budgetUsd.toFixed(2)} budget${report.stoppedAtBudget ? "; stopped at the budget" : ""}.`,
    "",
    `"Not supported" (overstated or unsupported) against the owner's labels: precision ${shareText(notSupported.precision)}, recall ${shareText(notSupported.recall)}.`,
    `Called as the owner did: ${shareText(report.accuracy)}.`,
    "",
    "| Sentence | Label | Verdict | Right | Note |",
    "|---|---|---|---|---|",
    ...report.items.map(
      (each) =>
        `| ${each.id} | ${each.label} | ${each.verdict ?? each.outcome} | ${each.right === null ? "–" : each.right ? "yes" : "no"} | ${cell(each.note ?? "")} |`,
    ),
  ].join("\n")}\n`;
}
