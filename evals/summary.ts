import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunReport } from "./command";
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
 * where it shows one. It is built from
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

/** The summary of the latest runs, as Markdown, written on `at`. */
export function summaryOf(reports: readonly RunReport[], at: Date): string {
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
  return `${lines.join("\n")}\n`;
}

const ADDRESS = /[^\s@<>()|]+@[^\s@<>()|]+\.[a-z]{2,}/gi;
/** Seven or more digits, single spaces allowed between them: a phone number, however spaced. */
const LONG_NUMBER = /\d(?: ?\d){6,}/g;

/** What in a summary could come from a case: its ID, an extracted value or note, an address, a long number. */
export function checkSummary(text: string, reports: readonly RunReport[]): string[] {
  // Route and eligibility are a few fixed words, which the summary names; the rest is the case's own.
  const fromCases = reports.flatMap((report) =>
    report.cases.flatMap((result) => [
      result.id,
      result.note ?? "",
      result.extracted?.company ?? "",
      result.extracted?.role ?? "",
      result.extracted?.contact ?? "",
    ]),
  );
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
