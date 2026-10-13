import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { EXTRACT, EXTRACT_PROMPT } from "@/core/extraction/extract";
import { assertLocalOnly } from "@/server/localOnly";

import { listCases, readCase } from "./cases";
import { styleExamplesOf } from "./import";
import {
  type CaseResult,
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

/**
 * `npm run eval` (evals spec, "Runs, budget and reports"): checks that the
 * run is local before anything else, with no production key or remote
 * database in the process or in .env.local (platform AC13), and refuses
 * without the evaluation key. It prints the cases and the most the run can
 * cost, and spends only with --yes, up to --budget. Test cases run only
 * with --final, which is recorded; per-case lines are printed for dev
 * alone. Each run writes report.json and report.md under
 * private/evals/runs/<time>-<stage>-<model>/.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface EvalIo {
  /** The process's variables and .env.local's, each checked for production values. */
  env: Env;
  localEnv: Env;
  archive: string;
  profileFile: string;
  /** private/evals: runs/ and final-runs.json. */
  evalsDir: string;
  commit: string;
  now(): Date;
  log(line: string): void;
  /** The run's local database (profile seeded), storage and models; opened only once spending is approved. */
  open(): Promise<RunDeps & { close(): Promise<void> }>;
}

export interface EvalArgs {
  stage: "extract";
  model: string;
  split: Split;
  final: boolean;
  yes: boolean;
  budgetUsd: number;
}

const STAGES_BUILT = ["extract"] as const;
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
      if (split !== "dev" && split !== "test") throw new Error("--split is dev or test");
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
  const split = args.split ?? "dev";
  if (split === "test" && !args.final) {
    throw new Error("Test cases are scored only with --final, which is recorded. Tune on dev.");
  }
  if (split === "dev" && args.final) throw new Error("--final is for the test split.");
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
  split: Split;
  final: boolean;
  startedAt: string;
  finishedAt: string;
  commit: string;
  prompt: string;
  effort: string;
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

function wrongFields(result: CaseResult): string {
  if (!result.matches) return "";
  return Object.entries(result.matches)
    .filter(([, right]) => !right)
    .map(([field]) => field)
    .join(", ");
}

/** The report's text: the metrics with their intervals, by route, and for dev each case. */
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
    "",
    ...HEADER,
    ...metricRows(report.metrics, (value) => value.pooled),
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
  if (report.split === "dev") {
    lines.push(
      "",
      "## Cases",
      "",
      "| Case | Outcome | Wrong | Note | Cost | Seconds |",
      "|---|---|---|---|---|---|",
    );
    for (const result of report.cases) {
      lines.push(
        `| ${result.id} | ${result.outcome} | ${wrongFields(result)} | ${(result.note ?? "").replaceAll("|", "/")} | ${dollars(result.costUsd)} | ${result.seconds.toFixed(1)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function evalCommand(argv: readonly string[], io: EvalIo): Promise<RunReport | null> {
  assertLocalOnly(io.env, "npm run eval");
  assertLocalOnly(io.localEnv, "npm run eval (.env.local)");
  if (!(io.localEnv.ANTHROPIC_EVALS_API_KEY ?? io.env.ANTHROPIC_EVALS_API_KEY)) {
    throw new Error(
      "npm run eval needs ANTHROPIC_EVALS_API_KEY in .env.local: see docs/runbook/setup.md",
    );
  }
  const args = parseEvalArgs(argv);
  const { examples } = styleExamplesOf(io.profileFile);
  const { cases, unlabelled } = await evalCases(io.archive, args.split, examples);
  const startedAt = io.now();
  let most = 0;
  for (const item of cases) most += await estimateCase(item, args.model, startedAt);
  const runs = join(io.evalsDir, "runs");
  io.log(
    `${cases.length} labelled ${args.split} cases to run; ${unlabelled} in ${args.split} have no labels yet.`,
  );
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

  const deps = await io.open();
  let run: ExtractionRun;
  try {
    run = await runExtraction(deps, cases, { model: args.model, budgetUsd: args.budgetUsd });
  } finally {
    await deps.close();
  }
  const report: RunReport = {
    ...run,
    stage: args.stage,
    split: args.split,
    final: args.final,
    startedAt: startedAt.toISOString(),
    finishedAt: io.now().toISOString(),
    commit: io.commit,
    prompt: EXTRACT_PROMPT,
    effort: EXTRACT.effort,
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
  if (args.split === "dev") {
    for (const result of run.cases) {
      const wrong = wrongFields(result);
      io.log(
        `  ${result.id}  ${result.outcome}${wrong ? `  wrong: ${wrong}` : ""}${result.note ? `  ${result.note}` : ""}`,
      );
    }
  }
  io.log(
    `Cost ${dollars(run.costUsd)}${run.stoppedAtBudget ? ", stopped at the budget" : ""}. Report: ${folder}`,
  );
  return report;
}
