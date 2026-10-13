import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunReport } from "./command";
import type { CaseResult } from "./run";
import { metricsOf } from "./run";
import { checkSummary, readReports, summaryOf } from "./summary";

/* The aggregate summary: evals AC6. Every name, address and number here is planted, to be kept out. */

const PLANTED = [
  "Northwind Analytics",
  "Sam Rivera",
  "jobs@northwind.example",
  "0300 1234567",
  "+92 321 7654321",
  "2026-03-16-8282e9a1",
  "Senior Full-Stack Engineer",
  "The post stopped: language.",
];

function result(id: string, right: boolean, overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id,
    split: "dev",
    route: "email",
    outcome: "scored",
    note: "Sam Rivera wrote from jobs@northwind.example; call 0300 1234567.",
    extracted: {
      company: "Northwind Analytics",
      role: "Senior Full-Stack Engineer",
      route: "email",
      contact: "jobs@northwind.example",
      eligibility: "eligible",
    },
    matches: { company: right, role: right, route: true, contact: right, eligibility: true },
    costUsd: 0.05,
    seconds: 20,
    ...overrides,
  };
}

function report(
  model: string,
  cases: CaseResult[],
  startedAt = "2026-10-13T12:00:00.000Z",
): RunReport {
  return {
    stage: "extract",
    split: "dev",
    final: false,
    startedAt,
    finishedAt: startedAt,
    commit: "0123456789abcdef0123",
    prompt: "a".repeat(64),
    effort: "medium",
    model,
    budgetUsd: 5,
    stoppedAtBudget: false,
    costUsd: cases.reduce((sum, each) => sum + each.costUsd, 0),
    cases,
    metrics: metricsOf(cases),
  };
}

const ids = (count: number) =>
  Array.from({ length: count }, (_, i) => `2026-03-16-${(i + 1).toString(16).padStart(8, "0")}`);

describe("summaryOf", () => {
  it("gives each run's shares with counts and intervals, its cost and time, and nothing from a case", () => {
    const cases = [
      ...ids(9).map((id) => result(id, true)),
      result("2026-03-16-8282e9a1", false, {
        note: "The post stopped: language.",
        route: "whatsapp",
      }),
    ];

    const text = summaryOf([report("claude-opus-5-5", cases)], new Date("2026-10-13T15:00:00Z"));

    expect(text).toContain("## extract, claude-opus-5-5, dev");
    expect(text).toContain("| company | 9 | 10 | 90% |");
    expect(text).toContain("| route | 10 | 10 | 100% | 72% to 100% |");
    expect(text).toContain("### whatsapp");
    expect(text).toMatch(/Cost \$0\.50; 20\.0 seconds a case \(median\)\./);
    for (const planted of PLANTED) expect(text).not.toContain(planted);
    expect(checkSummary(text, [report("claude-opus-5-5", cases)])).toEqual([]);
  });

  it("compares two models on the cases both scored, naming neither better unless the test shows it", () => {
    const shared = ids(12);
    const opus = report(
      "claude-opus-5-5",
      shared.map((id, i) => result(id, i < 11)),
    );
    const sonnet = report(
      "claude-sonnet-5-5",
      shared.map((id, i) => result(id, i < 2)),
      "2026-10-13T13:00:00.000Z",
    );
    const close = report(
      "claude-sonnet-5-5",
      shared.map((id, i) => result(id, i < 10)),
      "2026-10-13T14:00:00.000Z",
    );

    const shown = summaryOf([opus, sonnet], new Date("2026-10-13T15:00:00Z"));
    expect(shown).toContain("claude-opus-5-5 against claude-sonnet-5-5 on 12 dev cases");
    expect(shown).toMatch(/\| company \| 9 \| 0 \| 0\.004 \| claude-opus-5-5 \|/);

    // The latest run of a model stands for it.
    const notShown = summaryOf([opus, sonnet, close], new Date("2026-10-13T15:00:00Z"));
    expect(notShown).toMatch(/\| company \| 1 \| 0 \| 1 \| no difference shown \|/);
    expect(notShown).not.toContain("| company | 9 |");
  });
});

describe("checkSummary", () => {
  it("names anything from a case that a summary would carry, an address or a long number", () => {
    const cases = [result("2026-03-16-8282e9a1", true)];
    const leaky = "Runs: Northwind Analytics, write to someone@example.org or call 03001234567.";

    expect(checkSummary(leaky, [report("claude-opus-5-5", cases)])).toEqual([
      "Northwind Analytics",
      "someone@example.org",
      "03001234567",
    ]);
  });
});

describe("readReports", () => {
  it("reads every run's report, passing over a folder whose report cannot be read", () => {
    const runs = mkdtempSync(join(tmpdir(), "jobkit-runs-"));
    try {
      const write = (name: string, text: string) => {
        mkdirSync(join(runs, name));
        writeFileSync(join(runs, name, "report.json"), text);
      };
      write("a", JSON.stringify(report("claude-opus-5-5", [result("2026-03-16-00000001", true)])));
      write("b", "{ half a report");
      write("c", JSON.stringify({ startedAt: "2026-10-01T00:00:00.000Z" }));
      mkdirSync(join(runs, "d"));

      expect(readReports(runs).map((each) => each.model)).toEqual(["claude-opus-5-5"]);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
});
