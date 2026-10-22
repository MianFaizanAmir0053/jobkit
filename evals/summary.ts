import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type DraftReport,
  GAP_COVERAGE,
  type RunReport,
  type SecondReadReport,
  secondReadShares,
  verdictLines,
} from "./command";
import { compareJudgeRuns, type JudgeSetReport } from "./judgeSet";
import type { CaseResult } from "./run";
import { compareModels, type Proportion } from "./score";

/**
 * The aggregate summary (evals spec, "Runs, budget and reports"; AC6): for
 * the latest run of each stage, split and model, each field's share right
 * with its count and 95% interval, pooled and by route, the run's cost and
 * time, and for the synthetic posts each check's share met and the Chrome
 * that rendered them; and for two models run on the same cases, McNemar's
 * exact test, on the fields both scored and, for synthetic posts, only
 * those both read from the same screenshot, which names a better model only
 * where it shows one; and for drafting and the contact's second read their
 * measures, two second reads compared by the same test. It is built from
 * numbers and the fields' names alone, never from a case, and checkSummary
 * looks again before it is written: no case ID, extracted value or note,
 * and nothing shaped like an address or a phone number. No commit or prompt
 * hash either, since a long run of digits is what a phone number is.
 */

const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);

function formatP(p: number): string {
  if (p < 0.001) return "< 0.001";
  return p.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

const HEADER = ["| Field | Right | Of | Share | 95% interval |", "|---|---|---|---|---|"];
const CHECK_HEADER = ["| Check | Met | Of | Share | 95% interval |", "|---|---|---|---|---|"];

function shareRow(field: string, share: Proportion): string {
  return `| ${field} | ${share.successes} | ${share.n} | ${percent(share.point)} | ${percent(share.low)} to ${percent(share.high)} |`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const groupOf = (report: RunReport) => `${report.stage}|${report.split}|${report.final}`;

/** The drafting and second-read runs, beside extraction's. */
export interface StageRuns {
  drafts?: readonly DraftReport[];
  reads?: readonly SecondReadReport[];
}

/** The latest run of each split and model, among one stage's runs. */
function latestOf<T extends { split: string; final: boolean; model: string; startedAt: string }>(
  reports: readonly T[],
): T[] {
  const latest = new Map<string, T>();
  for (const report of reports) {
    const key = `${report.split}|${report.final}|${report.model}`;
    const kept = latest.get(key);
    if (!kept || kept.startedAt < report.startedAt) latest.set(key, report);
  }
  return [...latest.values()].sort(
    (a, b) =>
      `${a.split}|${a.final}`.localeCompare(`${b.split}|${b.final}`) ||
      a.model.localeCompare(b.model),
  );
}

function secondsLine(cases: readonly { outcome: string; seconds: number }[]): string {
  const seconds = median(
    cases.filter((each) => each.outcome === "scored").map((each) => each.seconds),
  );
  return seconds === null ? "no case timed" : `${seconds.toFixed(1)} seconds a case (median)`;
}

const MEASURE_HEADER = ["| Measure | Met | Of | Share | 95% interval |", "|---|---|---|---|---|"];

/** A drafting run: gap coverage, the separate check's verdicts, and the drafts' checks. */
function draftSection(report: DraftReport): string[] {
  const count = (outcome: string) =>
    report.cases.filter((result) => result.outcome === outcome).length;
  const lines = [
    `## draft, ${report.model}, ${report.split}${report.final ? " (final)" : ""}`,
    "",
    `Run on ${report.startedAt.slice(0, 10)}: ${count("scored")} cases drafted, ${count("no kit")} with no kit to draft, ${count("failed")} failed, ${count("budget")} not run for the budget.`,
    `Cost ${report.costUsd.toFixed(2)}; ${secondsLine(report.cases)}.`,
    ...(report.renders ? [`Screenshots rendered by Chrome ${report.renders.browser}.`] : []),
    "",
    ...MEASURE_HEADER,
    shareRow(GAP_COVERAGE, report.gapCoverage),
    "",
    "### The separate check's verdicts",
    "",
    ...verdictLines(report.verdicts),
  ];
  const checks = Object.entries(report.checks).filter(
    (entry): entry is [string, Proportion] => entry[1] !== undefined,
  );
  if (checks.length > 0) {
    lines.push(
      "",
      "### Checks on what the draft did",
      "",
      ...CHECK_HEADER,
      ...checks.map(([key, share]) => shareRow(key, share)),
    );
  }
  return lines;
}

/** A second-read run: its three measures. */
function secondReadSection(report: SecondReadReport): string[] {
  const count = (outcome: string) =>
    report.cases.filter((result) => result.outcome === outcome).length;
  return [
    `## address_read, ${report.model}, ${report.split}${report.final ? " (final)" : ""}`,
    "",
    `Run on ${report.startedAt.slice(0, 10)}: ${count("scored")} cases read a second time by the model, ${count("not read")} not, ${count("budget")} not run for the budget.`,
    `Cost ${report.costUsd.toFixed(2)}; ${secondsLine(report.cases)}.`,
    ...(report.renders ? [`Screenshots rendered by Chrome ${report.renders.browser}.`] : []),
    "",
    ...MEASURE_HEADER,
    ...Object.entries(secondReadShares(report)).map(([name, share]) => shareRow(name, share)),
  ];
}

/**
 * Two second-read runs on one split: whether each second read matched the
 * label, on the cases both read from the same screenshot.
 */
function secondReadComparison(first: SecondReadReport, second: SecondReadReport): string[] {
  const scoredIn = (report: SecondReadReport) =>
    new Map(
      report.cases
        .filter((result) => result.outcome === "scored" && result.secondRight !== null)
        .map((result) => [result.id, result.secondRight!]),
    );
  const one = scoredIn(first);
  const other = scoredIn(second);
  const image = (report: SecondReadReport, id: string) => report.renders?.images[`${id}.png`];
  const shared = [...one.keys()].filter(
    (id) => other.has(id) && image(first, id) === image(second, id),
  );
  const lines = [
    `## address_read: ${first.model} against ${second.model} on ${shared.length} ${first.split} cases`,
    "",
  ];
  if (shared.length === 0) return [...lines, "No case is left to compare."];
  const compared = compareModels(
    shared.map((id) => ({ first: one.get(id)!, second: other.get(id)! })),
  );
  const better =
    compared.verdict === "first"
      ? first.model
      : compared.verdict === "second"
        ? second.model
        : "no difference shown";
  return [
    ...lines,
    "McNemar's exact test on the cases where only one model's second read matched the label; a model is named only below p = 0.05.",
    "",
    `| Only ${first.model} | Only ${second.model} | p | Better |`,
    "|---|---|---|---|",
    `| ${compared.onlyFirst} | ${compared.onlySecond} | ${formatP(compared.p)} | ${better} |`,
  ];
}

/** The latest run of each stage, split and model. */
function latestRuns(reports: readonly RunReport[]): RunReport[] {
  const latest = new Map<string, RunReport>();
  for (const report of reports) {
    const key = `${groupOf(report)}|${report.model}`;
    const kept = latest.get(key);
    if (!kept || kept.startedAt < report.startedAt) latest.set(key, report);
  }
  return [...latest.values()].sort(
    (a, b) => groupOf(a).localeCompare(groupOf(b)) || a.model.localeCompare(b.model),
  );
}

function runSection(report: RunReport): string[] {
  const count = (outcome: CaseResult["outcome"]) =>
    report.cases.filter((result) => result.outcome === outcome).length;
  const scored = report.cases.filter((result) => result.outcome === "scored");
  const seconds = median(scored.map((result) => result.seconds));
  const lines = [
    `## ${report.stage}, ${report.model}, ${report.split}${report.final ? " (final)" : ""}`,
    "",
    `Run on ${report.startedAt.slice(0, 10)}: ${count("scored")} cases scored, ${count("failed")} failed, ${count("budget")} not run for the budget.`,
    `Cost $${report.costUsd.toFixed(2)}; ${seconds === null ? "no case timed" : `${seconds.toFixed(1)} seconds a case (median)`}.`,
    ...(report.renders ? [`Screenshots rendered by Chrome ${report.renders.browser}.`] : []),
    "",
    ...HEADER,
    ...Object.entries(report.metrics).map(([field, value]) => shareRow(field, value.pooled)),
  ];
  const checks = Object.entries(report.checks).filter(
    (entry): entry is [string, Proportion] => entry[1] !== undefined,
  );
  if (checks.length > 0) {
    const later = [
      ...new Set(
        scored.flatMap((result) =>
          result.checks.filter((check) => check.met === null).map((check) => check.key),
        ),
      ),
    ];
    lines.push(
      "",
      "### Checks on what the model noticed",
      "",
      ...CHECK_HEADER,
      ...checks.map(([key, share]) => shareRow(key, share)),
      ...(later.length > 0 ? ["", `Left to later stages: ${later.join(", ")}.`] : []),
    );
  }
  const routes = [
    ...new Set(Object.values(report.metrics).flatMap((value) => Object.keys(value.byRoute))),
  ].sort();
  for (const route of routes) {
    lines.push("", `### ${route}`, "", ...HEADER);
    for (const [field, value] of Object.entries(report.metrics)) {
      const share = value.byRoute[route];
      if (share) lines.push(shareRow(field, share));
    }
  }
  return lines;
}

/**
 * Two models' latest runs on one split: per field, on the cases both scored
 * and labelled. A synthetic post read from different screenshots in the two
 * runs is left out, and said to be, since a difference there could come
 * from the images.
 */
function comparisonSection(first: RunReport, second: RunReport): string[] {
  const scoredIn = (report: RunReport) =>
    new Map(
      report.cases
        .filter((result) => result.outcome === "scored" && result.matches)
        .map((result) => [result.id, result.matches!]),
    );
  const one = scoredIn(first);
  const other = scoredIn(second);
  const image = (report: RunReport, id: string) => report.renders?.images[`${id}.png`];
  const both = [...one.keys()].filter((id) => other.has(id));
  const shared = both.filter((id) => image(first, id) === image(second, id));
  const apart = both.length - shared.length;
  const browsers =
    first.renders && second.renders && first.renders.browser !== second.renders.browser
      ? ` (rendered by Chrome ${first.renders.browser} and Chrome ${second.renders.browser})`
      : "";
  const lines = [
    `## ${first.model} against ${second.model} on ${shared.length} ${first.split} cases`,
    "",
    ...(apart > 0
      ? [
          `${apart} more both scored ${apart === 1 ? "is" : "are"} left out: the runs read different screenshots of ${apart === 1 ? "it" : "them"}${browsers}, so a difference there could come from the images.`,
          "",
        ]
      : []),
  ];
  if (shared.length === 0) return [...lines, "No case is left to compare."];
  lines.push(
    "McNemar's exact test on the cases only one model got right; a model is named only below p = 0.05.",
    "",
    `| Field | Only ${first.model} | Only ${second.model} | p | Better |`,
    "|---|---|---|---|---|",
  );
  for (const field of Object.keys(first.metrics) as (keyof NonNullable<CaseResult["matches"]>)[]) {
    const judged = shared.filter(
      (id) => one.get(id)![field] !== undefined && other.get(id)![field] !== undefined,
    );
    // A field no shared case labels, as a synthetic post may not, has nothing to compare.
    if (judged.length === 0) continue;
    const compared = compareModels(
      judged.map((id) => ({ first: one.get(id)![field]!, second: other.get(id)![field]! })),
    );
    const better =
      compared.verdict === "first"
        ? first.model
        : compared.verdict === "second"
          ? second.model
          : "no difference shown";
    lines.push(
      `| ${field} | ${compared.onlyFirst} | ${compared.onlySecond} | ${formatP(compared.p)} | ${better} |`,
    );
  }
  return lines;
}

/** The latest run of each model on the judge set, and on the claims from live drafts. */
function latestJudgeRuns(reports: readonly JudgeSetReport[]): JudgeSetReport[] {
  const latest = new Map<string, JudgeSetReport>();
  for (const report of reports) {
    const key = `${report.stage}|${report.model}`;
    const kept = latest.get(key);
    if (!kept || kept.startedAt < report.startedAt) latest.set(key, report);
  }
  return [...latest.values()].sort(
    (a, b) => b.stage.localeCompare(a.stage) || a.model.localeCompare(b.model),
  );
}

/** A judge run: "not supported" against the owner's labels, with intervals; for live claims, the check as it ran too. */
function judgeSection(report: JudgeSetReport): string[] {
  const count = (outcome: JudgeSetReport["items"][number]["outcome"]) =>
    report.items.filter((each) => each.outcome === outcome).length;
  const { precision, recall } = report.notSupported;
  return [
    `## ${report.stage}, ${report.model}`,
    "",
    `Run on ${report.startedAt.slice(0, 10)}: ${count("scored")} sentences scored, ${count("failed")} failed, ${count("budget")} not run for the budget. Cost ${report.costUsd.toFixed(2)}.`,
    "",
    "| Measure | Right | Of | Share | 95% interval |",
    "|---|---|---|---|---|",
    shareRow('Precision of "not supported"', precision),
    shareRow('Recall of "not supported"', recall),
    shareRow("Called as the owner did", report.accuracy),
    ...(report.live
      ? [
          shareRow(
            'Precision of "not supported", as the check ran live',
            report.live.notSupported.precision,
          ),
          shareRow(
            'Recall of "not supported", as the check ran live',
            report.live.notSupported.recall,
          ),
        ]
      : []),
  ];
}

/** The summary of the latest runs, as Markdown, written on `at`. */
export function summaryOf(
  reports: readonly RunReport[],
  at: Date,
  judges: readonly JudgeSetReport[] = [],
  stages: StageRuns = {},
): string {
  const runs = latestRuns(reports);
  const lines = [
    "# Evaluation summary",
    "",
    `Written ${at.toISOString().slice(0, 10)}. Aggregates only: each share with its count and 95% interval, cost and time; no case's words, no names, addresses or phone numbers.`,
  ];
  for (const report of runs) lines.push("", ...runSection(report));
  for (const [i, first] of runs.entries()) {
    for (const second of runs.slice(i + 1)) {
      if (groupOf(first) === groupOf(second)) lines.push("", ...comparisonSection(first, second));
    }
  }
  // Drafting runs are compared by their intervals: gap coverage counts gaps, which differ by run.
  for (const report of latestOf(stages.drafts ?? [])) lines.push("", ...draftSection(report));
  const reads = latestOf(stages.reads ?? []);
  for (const report of reads) lines.push("", ...secondReadSection(report));
  for (const [i, first] of reads.entries()) {
    for (const second of reads.slice(i + 1)) {
      if (first.split === second.split && first.final === second.final) {
        lines.push("", ...secondReadComparison(first, second));
      }
    }
  }
  const judgeRuns = latestJudgeRuns(judges);
  for (const report of judgeRuns) lines.push("", ...judgeSection(report));
  for (const [i, first] of judgeRuns.entries()) {
    for (const second of judgeRuns.slice(i + 1)) {
      if (first.stage !== second.stage) continue;
      const compared = compareJudgeRuns(first, second);
      const better =
        compared.verdict === "first"
          ? first.model
          : compared.verdict === "second"
            ? second.model
            : "no difference shown";
      lines.push(
        "",
        `## ${first.stage}: ${first.model} against ${second.model}`,
        "",
        "McNemar's exact test on the sentences only one model called as the owner did; a model is named only below p = 0.05.",
        "",
        `| Only ${first.model} | Only ${second.model} | p | Better |`,
        "|---|---|---|---|",
        `| ${compared.onlyFirst} | ${compared.onlySecond} | ${formatP(compared.p)} | ${better} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

const ADDRESS = /[^\s@<>()|]+@[^\s@<>()|]+\.[a-z]{2,}/gi;
/** Seven or more digits, single spaces allowed between them: a phone number, however spaced. */
const LONG_NUMBER = /\d(?: ?\d){6,}/g;

/** What in a summary could come from a case: its ID, an extracted value or note, an address, a long number. */
export function checkSummary(
  text: string,
  reports: readonly RunReport[],
  judges: readonly JudgeSetReport[] = [],
  stages: StageRuns = {},
): string[] {
  // Route and eligibility are a few fixed words, which the summary names; the rest is the case's own.
  const fromCases = [
    ...reports.flatMap((report) =>
      report.cases.flatMap((result) => [
        result.id,
        result.note ?? "",
        result.extracted?.company ?? "",
        result.extracted?.role ?? "",
        result.extracted?.contact ?? "",
      ]),
    ),
    // A judge's note on a sentence can quote the owner's facts, and a claim from a live draft is
    // named by its case (`<case>/<block>`), whose ID no summary may carry.
    ...judges.flatMap((report) =>
      report.items.flatMap((each) => [
        each.note ?? "",
        report.stage === "judge" ? each.id.split("/")[0]! : "",
      ]),
    ),
    ...(stages.drafts ?? []).flatMap((report) =>
      report.cases.flatMap((result) => [
        result.id,
        result.note ?? "",
        ...result.checks.map((check) => check.note),
      ]),
    ),
    ...(stages.reads ?? []).flatMap((report) =>
      report.cases.flatMap((result) => [result.id, result.note ?? ""]),
    ),
  ];
  const found = new Set<string>();
  for (const value of fromCases) {
    if (value.trim().length >= 3 && text.includes(value)) found.add(value);
  }
  for (const match of [...text.matchAll(ADDRESS), ...text.matchAll(LONG_NUMBER)]) {
    found.add(match[0]);
  }
  return [...found];
}

/** Every run's report under `runs`, passing over any that cannot be read as one. */
export function readReports(runs: string): RunReport[] {
  if (!existsSync(runs)) return [];
  const reports: RunReport[] = [];
  for (const name of readdirSync(runs).sort()) {
    const file = join(runs, name, "report.json");
    if (!existsSync(file)) continue;
    try {
      const report = JSON.parse(readFileSync(file, "utf8")) as Partial<RunReport>;
      if (Array.isArray(report.cases) && report.metrics && typeof report.model === "string") {
        // A report from before checks and renders were recorded has none of either.
        reports.push({
          ...(report as RunReport),
          checks: report.checks ?? {},
          renders: report.renders ?? null,
          cases: report.cases.map((result) => ({ ...result, checks: result.checks ?? [] })),
        });
      }
    } catch {
      // Not a report this version can read.
    }
  }
  return reports;
}

/** Every drafting and second-read run's report under `runs`, passing over any that cannot be read as one. */
export function readStageRuns(runs: string): {
  drafts: DraftReport[];
  reads: SecondReadReport[];
} {
  const drafts: DraftReport[] = [];
  const reads: SecondReadReport[] = [];
  if (!existsSync(runs)) return { drafts, reads };
  for (const name of readdirSync(runs).sort()) {
    const file = join(runs, name, "report.json");
    if (!existsSync(file)) continue;
    try {
      const report = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!Array.isArray(report.cases) || typeof report.model !== "string") continue;
      if (report.stage === "draft" && report.gapCoverage) {
        const draft = report as unknown as DraftReport;
        drafts.push({
          ...draft,
          verdicts: draft.verdicts ?? {},
          checks: draft.checks ?? {},
          renders: draft.renders ?? null,
          cases: draft.cases.map((result) => ({ ...result, checks: result.checks ?? [] })),
        });
      }
      if (report.stage === "address_read" && report.agreesWithLabel) {
        const read = report as unknown as SecondReadReport;
        reads.push({ ...read, renders: read.renders ?? null });
      }
    } catch {
      // Not a report this version can read.
    }
  }
  return { drafts, reads };
}

/** Every judge-set run's report under `runs`, passing over any that cannot be read as one. */
export function readJudgeReports(runs: string): JudgeSetReport[] {
  if (!existsSync(runs)) return [];
  const reports: JudgeSetReport[] = [];
  for (const name of readdirSync(runs).sort()) {
    const file = join(runs, name, "report.json");
    if (!existsSync(file)) continue;
    try {
      const report = JSON.parse(readFileSync(file, "utf8")) as Partial<JudgeSetReport>;
      if (
        (report.stage === "judge-set" || report.stage === "judge") &&
        Array.isArray(report.items) &&
        report.notSupported
      ) {
        reports.push(report as JudgeSetReport);
      }
    } catch {
      // Not a report this version can read.
    }
  }
  return reports;
}
