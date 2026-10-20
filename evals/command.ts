import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { JUDGE, JUDGE_PROMPT } from "@/core/drafting/judgeStage";
import { EXTRACT, EXTRACT_PROMPT } from "@/core/extraction/extract";
import { providerOf } from "@/core/platform/models";
import { assertLocalOnly } from "@/server/localOnly";

import { listCases, readCase } from "./cases";
import { styleExamplesOf } from "./import";
import {
  estimateJudgeItem,
  type JudgeSetReport,
  judgeReportMarkdown,
  readJudgeSet,
  runJudgeSet,
} from "./judgeSet";
import {
  type CaseResult,
  type CaseSplit,
  type CheckMetrics,
  type EvalCase,
  estimateCase,
  type ExtractionRun,
  type FieldMetrics,
  type ImageType,
  type RunDeps,
  runExtraction,
} from "./run";
import type { Proportion } from "./score";
import type { Split } from "./split";
import { type Renders, syntheticCases } from "./synthetic";

/**
 * `npm run eval` (evals spec, "Runs, budget and reports"): checks that the
 * run is local before anything else, with no production key or remote
 * database in the process or in .env.local (platform AC13), and refuses
 * without the evaluation key of the model it runs. It prints the cases and the most the run can
 * cost, and spends only with --yes, up to --budget. Test cases run only
 * with --final, which is recorded; per-case lines are printed for dev and
 * the synthetic posts alone. `--split synthetic` runs the public posts on
 * the sample profile they were written for, refused while the render
 * manifest does not vouch for every screenshot, and records the Chrome that
 * rendered them and each image's hash, so runs on other renders are never
 * compared unawares. Each run writes report.json and report.md under
 * private/evals/runs/<time>-<stage>-<model>/.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface EvalIo {
  /** The process's variables and .env.local's, each checked for production values. */
  env: Env;
  localEnv: Env;
  archive: string;
  /** The owner's profile: the archive's cases run on it, and its style examples exclude cases. */
  profileFile: string;
  /** evals/synthetic: the public posts, their renders, and the sample profile they run on. */
  syntheticDir: string;
  /** private/evals: runs/ and final-runs.json. */
  evalsDir: string;
  commit: string;
  now(): Date;
  log(line: string): void;
  /** The run's local database with this profile seeded, storage and models; opened only once spending is approved. */
  open(profileFile: string): Promise<RunDeps & { close(): Promise<void> }>;
}

export interface EvalArgs {
  stage: (typeof STAGES_BUILT)[number];
  model: string;
  split: CaseSplit;
  final: boolean;
  yes: boolean;
  budgetUsd: number;
}

const STAGES_BUILT = ["extract", "judge-set"] as const;

/** The evaluation key each provider's models run on (platform spec B8). */
const EVAL_KEYS = {
  anthropic: "ANTHROPIC_EVALS_API_KEY",
  gemini: "GEMINI_EVALS_API_KEY",
} as const;
const DEFAULT_BUDGET_USD = 5;

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const args: Partial<EvalArgs> = { final: false, yes: false };
  let stage: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--stage") stage = value();
    else if (flag === "--model") args.model = value();
    else if (flag === "--split") {
      const split = value();
      if (split !== "dev" && split !== "test" && split !== "synthetic") {
        throw new Error("--split is dev, test or synthetic");
      }
      args.split = split;
    } else if (flag === "--budget") {
      const budget = Number(value());
      if (!Number.isFinite(budget) || budget <= 0) throw new Error("--budget is dollars above 0");
      args.budgetUsd = budget;
    } else if (flag === "--final") args.final = true;
    else if (flag === "--yes") args.yes = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!stage) throw new Error("Name the stage: npm run eval -- --stage extract");
  if (!(STAGES_BUILT as readonly string[]).includes(stage)) {
    throw new Error(`Only ${STAGES_BUILT.join(", ")} can be evaluated so far.`);
  }
  // The judge set is one frozen set of sentences, run whole: it has no split.
  if (stage === "judge-set") {
    if (args.split !== undefined || args.final) {
      throw new Error(
        "The judge set is one set, with no split: run it without --split or --final.",
      );
    }
    return {
      stage: "judge-set",
      model: args.model ?? JUDGE.model,
      split: "dev",
      final: false,
      yes: args.yes ?? false,
      budgetUsd: args.budgetUsd ?? DEFAULT_BUDGET_USD,
    };
  }
  const split = args.split ?? "dev";
  if (split === "test" && !args.final) {
    throw new Error("Test cases are scored only with --final, which is recorded. Tune on dev.");
  }
  if (split !== "test" && args.final) throw new Error("--final is for the test split.");
  return {
    stage: "extract",
    model: args.model ?? EXTRACT.model,
    split,
    final: args.final ?? false,
    yes: args.yes ?? false,
    budgetUsd: args.budgetUsd ?? DEFAULT_BUDGET_USD,
  };
}

const IMAGE_TYPES: Readonly<Record<string, ImageType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** The labelled cases of a split, ready to run; and how many of the split's cases have no labels yet. */
export async function evalCases(
  archive: string,
  split: Split,
  styleExamples: readonly string[],
): Promise<{ cases: EvalCase[]; unlabelled: number }> {
  const options = { styleExamples };
  const { cases: listed } = await listCases(archive, options);
  const inSplit = listed.filter(
    (entry) => entry.split === split && !entry.leftOut && entry.problem === null,
  );
  const cases: EvalCase[] = [];
  for (const entry of inSplit.filter((each) => each.labelled)) {
    const found = await readCase(archive, entry.id, options);
    if (!found?.labels) continue;
    cases.push({
      id: found.id,
      split,
      images: found.screenshotFiles.map((file) => ({
        bytes: new Uint8Array(readFileSync(join(archive, found.id, file))),
        contentType: IMAGE_TYPES[extname(file).toLowerCase()]!,
      })),
      pastedText: found.pastedText ?? "",
      labels: found.labels,
    });
  }
  return { cases, unlabelled: inSplit.length - cases.length };
}

export interface RunReport extends ExtractionRun {
  stage: "extract";
  split: CaseSplit;
  final: boolean;
  startedAt: string;
  finishedAt: string;
  commit: string;
  prompt: string;
  effort: string;
  /** For the synthetic posts, the screenshots read: the Chrome that rendered them, and each one's SHA-256. */
  renders: Renders | null;
}

/** What the evaluation runs recorded so far have spent in the month of `now`. */
function spentThisMonth(runs: string, now: Date): number {
  if (!existsSync(runs)) return 0;
  const month = now.toISOString().slice(0, 7);
  let spent = 0;
  for (const name of readdirSync(runs)) {
    const file = join(runs, name, "report.json");
    if (!existsSync(file)) continue;
    try {
      const report = JSON.parse(readFileSync(file, "utf8")) as Partial<RunReport>;
      if (report.startedAt?.slice(0, 7) === month) spent += report.costUsd ?? 0;
    } catch {
      // A report that cannot be read counts nothing.
    }
  }
  return spent;
}

const dollars = (usd: number) => `$${usd.toFixed(2)}`;
const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);

function metricRows(
  metrics: FieldMetrics,
  pick: (field: FieldMetrics[keyof FieldMetrics]) => Proportion | undefined,
) {
  return Object.entries(metrics).map(([field, value]) => {
    const share = pick(value) ?? { successes: 0, n: 0, point: null, low: null, high: null };
    return `| ${field} | ${share.successes} | ${share.n} | ${percent(share.point)} | ${percent(share.low)} to ${percent(share.high)} |`;
  });
}

const HEADER = ["| Field | Right | Of | Share | 95% interval |", "|---|---|---|---|---|"];
const CHECK_HEADER = ["| Check | Met | Of | Share | 95% interval |", "|---|---|---|---|---|"];

function shareRows(shares: Readonly<Record<string, Proportion | undefined>>) {
  return Object.entries(shares).map(([name, share]) =>
    share
      ? `| ${name} | ${share.successes} | ${share.n} | ${percent(share.point)} | ${percent(share.low)} to ${percent(share.high)} |`
      : `| ${name} | 0 | 0 | – | – to – |`,
  );
}

function wrongFields(result: CaseResult): string {
  if (!result.matches) return "";
  return Object.entries(result.matches)
    .filter(([, right]) => !right)
    .map(([field]) => field)
    .join(", ");
}

const unmetChecks = (result: CaseResult) => result.checks.filter((check) => check.met === false);

/** The expectations the stage left to a later one, by key. */
function laterChecks(cases: readonly CaseResult[]): string[] {
  return [
    ...new Set(
      cases
        .flatMap((result) => result.checks)
        .filter((check) => check.met === null)
        .map((check) => check.key),
    ),
  ];
}

/** The checks' shares, and what the stage left to later ones; none for a run without checks. */
function checkLines(checks: CheckMetrics, cases: readonly CaseResult[]): string[] {
  if (Object.keys(checks).length === 0) return [];
  const later = laterChecks(cases);
  return [
    "",
    "## Checks",
    "",
    "What the model noticed, on the posts that expect it.",
    "",
    ...CHECK_HEADER,
    ...shareRows(checks),
    ...(later.length > 0 ? ["", `Left to later stages: ${later.join(", ")}.`] : []),
  ];
}

/** The report's text: the metrics with their intervals, by route, the checks, and for dev and synthetic each case. */
export function reportMarkdown(report: RunReport): string {
  const counts = (outcome: CaseResult["outcome"]) =>
    report.cases.filter((result) => result.outcome === outcome).length;
  const routes = [
    ...new Set(Object.values(report.metrics).flatMap((value) => Object.keys(value.byRoute))),
  ];
  const lines = [
    `# ${report.stage}, ${report.model}, ${report.split}${report.final ? " (final)" : ""}`,
    "",
    `Run at ${report.startedAt}, commit ${report.commit.slice(0, 12)}, prompt ${report.prompt.slice(0, 12)}, effort ${report.effort}.`,
    `Cases: ${counts("scored")} scored, ${counts("failed")} failed, ${counts("budget")} not run for the budget. Cost ${dollars(report.costUsd)} of a ${dollars(report.budgetUsd)} budget${report.stoppedAtBudget ? "; stopped at the budget" : ""}.`,
    ...(report.renders
      ? [
          `Screenshots rendered by Chrome ${report.renders.browser}; each image's SHA-256 is in report.json.`,
        ]
      : []),
    "",
    ...HEADER,
    ...metricRows(report.metrics, (value) => value.pooled),
    ...checkLines(report.checks, report.cases),
  ];
  for (const route of routes.sort()) {
    lines.push(
      "",
      `## ${route}`,
      "",
      ...HEADER,
      ...metricRows(report.metrics, (value) => value.byRoute[route]),
    );
  }
  if (report.split !== "test") {
    const cell = (text: string) => text.replaceAll("|", "/").replaceAll("\n", " ");
    lines.push(
      "",
      "## Cases",
      "",
      "| Case | Outcome | Wrong | Checks not met | Note | Cost | Seconds |",
      "|---|---|---|---|---|---|---|",
    );
    for (const result of report.cases) {
      const unmet = unmetChecks(result)
        .map((check) => `${check.key}: ${check.note}`)
        .join("; ");
      lines.push(
        `| ${result.id} | ${result.outcome} | ${wrongFields(result)} | ${cell(unmet)} | ${cell(result.note ?? "")} | ${dollars(result.costUsd)} | ${result.seconds.toFixed(1)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The judge set's run (evals spec, "Metrics", the judge): every labelled
 * sentence of private/evals/judge-set.json, each through the judge's own
 * prompt, up to the budget; its report beside the others.
 */
export async function judgeSetCommand(args: EvalArgs, io: EvalIo): Promise<JudgeSetReport | null> {
  const file = join(io.evalsDir, "judge-set.json");
  const set = readJudgeSet(file);
  if (!set) throw new Error(`No judge set yet: make it with npm run eval:judge-set (${file}).`);
  const labelled = set.items.filter((item) => item.label !== null);
  io.log(
    `${labelled.length} labelled sentences of the judge set's ${set.items.length} to run; ${set.items.length - labelled.length} have no label yet.`,
  );
  const startedAt = io.now();
  const most = labelled.reduce(
    (sum, item) => sum + estimateJudgeItem(item, args.model, startedAt),
    0,
  );
  const runs = join(io.evalsDir, "runs");
  io.log(
    `At most ${dollars(most)} for judge-set with ${args.model}; the run stops before passing its budget of ${dollars(args.budgetUsd)}.`,
  );
  io.log(`Evaluation runs this month have spent ${dollars(spentThisMonth(runs, startedAt))}.`);
  if (!args.yes) {
    io.log("Nothing was spent. Run again with --yes to spend.");
    return null;
  }
  if (labelled.length === 0) {
    io.log("No labelled sentences, so nothing to run: label them on /dev/label/judge.");
    return null;
  }
  const deps = await io.open(io.profileFile);
  let report: JudgeSetReport;
  try {
    const run = await runJudgeSet(deps, set, { model: args.model, budgetUsd: args.budgetUsd });
    report = {
      ...run,
      stage: "judge-set",
      startedAt: startedAt.toISOString(),
      finishedAt: io.now().toISOString(),
      commit: io.commit,
      prompt: JUDGE_PROMPT,
      effort: JUDGE.effort,
    };
  } finally {
    await deps.close();
  }
  const folder = join(runs, `${report.startedAt.replaceAll(":", "-")}-judge-set-${args.model}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(folder, "report.md"), judgeReportMarkdown(report));
  const { precision, recall } = report.notSupported;
  io.log(
    `Not supported: precision ${precision.successes} of ${precision.n} (${percent(precision.point)}, ${percent(precision.low)} to ${percent(precision.high)}), recall ${recall.successes} of ${recall.n} (${percent(recall.point)}, ${percent(recall.low)} to ${percent(recall.high)}).`,
  );
  io.log(
    `Cost ${dollars(report.costUsd)}${report.stoppedAtBudget ? ", stopped at the budget" : ""}. Report: ${folder}`,
  );
  return report;
}

/**
 * The command. Extraction's report comes back for the caller; the judge
 * set's is written and printed, and none comes back.
 */
export async function evalCommand(argv: readonly string[], io: EvalIo): Promise<RunReport | null> {
  assertLocalOnly(io.env, "npm run eval");
  assertLocalOnly(io.localEnv, "npm run eval (.env.local)");
  const args = parseEvalArgs(argv);
  const key = EVAL_KEYS[providerOf(args.model)];
  if (!(io.localEnv[key] ?? io.env[key])) {
    throw new Error(
      `npm run eval needs ${key} in .env.local to run ${args.model}: see docs/runbook/setup.md`,
    );
  }
  if (args.stage === "judge-set") {
    await judgeSetCommand(args, io);
    return null;
  }
  const { split } = args;
  let cases: EvalCase[];
  let renders: Renders | null = null;
  if (split === "synthetic") {
    ({ cases, renders } = syntheticCases(io.syntheticDir));
  } else {
    const { examples } = styleExamplesOf(io.profileFile);
    const found = await evalCases(io.archive, split, examples);
    cases = found.cases;
    io.log(
      `${cases.length} labelled ${split} cases to run; ${found.unlabelled} in ${split} have no labels yet.`,
    );
  }
  if (renders) {
    io.log(`${cases.length} synthetic posts to run, rendered by Chrome ${renders.browser}.`);
  }
  const startedAt = io.now();
  let most = 0;
  for (const item of cases) most += await estimateCase(item, args.model, startedAt);
  const runs = join(io.evalsDir, "runs");
  io.log(
    `At most ${dollars(most)} for ${args.stage} with ${args.model}; the run stops before passing its budget of ${dollars(args.budgetUsd)}.`,
  );
  io.log(`Evaluation runs this month have spent ${dollars(spentThisMonth(runs, startedAt))}.`);
  if (!args.yes) {
    io.log("Nothing was spent. Run again with --yes to spend.");
    return null;
  }
  if (cases.length === 0) {
    io.log("No labelled cases, so nothing to run.");
    return null;
  }

  // The synthetic posts' eligibility and gaps were written for the sample profile, never the owner's.
  const deps = await io.open(
    split === "synthetic" ? join(io.syntheticDir, "profile.sample.yaml") : io.profileFile,
  );
  let run: ExtractionRun;
  try {
    run = await runExtraction(deps, cases, { model: args.model, budgetUsd: args.budgetUsd });
  } finally {
    await deps.close();
  }
  const report: RunReport = {
    ...run,
    stage: "extract",
    split: args.split,
    final: args.final,
    startedAt: startedAt.toISOString(),
    finishedAt: io.now().toISOString(),
    commit: io.commit,
    prompt: EXTRACT_PROMPT,
    effort: EXTRACT.effort,
    renders,
  };
  const folder = join(runs, `${report.startedAt.replaceAll(":", "-")}-${args.stage}-${args.model}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(folder, "report.md"), reportMarkdown(report));
  if (args.final) {
    const finals = join(io.evalsDir, "final-runs.json");
    const earlier = existsSync(finals)
      ? (JSON.parse(readFileSync(finals, "utf8")) as unknown[])
      : [];
    const entry = {
      at: report.startedAt,
      stage: args.stage,
      model: args.model,
      commit: io.commit,
      report: folder,
    };
    writeFileSync(finals, `${JSON.stringify([...earlier, entry], null, 2)}\n`);
  }

  for (const [field, value] of Object.entries(run.metrics)) {
    const share = value.pooled;
    io.log(
      `${field}: ${share.successes} of ${share.n} (${percent(share.point)}, ${percent(share.low)} to ${percent(share.high)})`,
    );
  }
  if (Object.keys(run.checks).length > 0) {
    io.log("Checks on what the model noticed:");
    for (const [key, share] of Object.entries(run.checks)) {
      io.log(
        `  ${key}: ${share.successes} of ${share.n} (${percent(share.point)}, ${percent(share.low)} to ${percent(share.high)})`,
      );
    }
    const later = laterChecks(run.cases);
    if (later.length > 0) io.log(`  Left to later stages: ${later.join(", ")}.`);
  }
  if (split !== "test") {
    for (const result of run.cases) {
      const wrong = wrongFields(result);
      const unmet = unmetChecks(result);
      io.log(
        `  ${result.id}  ${result.outcome}${wrong ? `  wrong: ${wrong}` : ""}${unmet.length > 0 ? `  checks not met: ${unmet.map((check) => check.key).join(", ")}` : ""}${result.note ? `  ${result.note}` : ""}`,
      );
      for (const check of unmet) io.log(`      ${check.key}: ${check.note}`);
    }
  }
  io.log(
    `Cost ${dollars(run.costUsd)}${run.stoppedAtBudget ? ", stopped at the budget" : ""}. Report: ${folder}`,
  );
  return report;
}
