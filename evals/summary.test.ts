import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DraftReport, RunReport, SecondReadReport } from "./command";
import type { CaseResult } from "./run";
import { checkMetricsOf, metricsOf } from "./run";
import type { Renders } from "./synthetic";
import { wilson } from "./score";
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
    checks: [],
    costUsd: 0.05,
    seconds: 20,
    ...overrides,
  };
}

function report(
  model: string,
  cases: CaseResult[],
  startedAt = "2026-10-13T12:00:00.000Z",
  renders: Renders | null = null,
): RunReport {
  return {
    stage: "extract",
    split: renders ? "synthetic" : "dev",
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
    checks: checkMetricsOf(cases),
    renders,
  };
}

const RENDERS: Renders = {
  browser: "155.0.8059.40",
  images: { "S01-email-simple.png": "a".repeat(64), "S06-number.png": "b".repeat(64) },
};

/** A synthetic post's result, scored on the fields it gives. */
const post = (id: string, matches: CaseResult["matches"], checks: CaseResult["checks"] = []) =>
  result(id, true, { split: "synthetic", note: null, matches, checks });

const ids = (count: number) =>
  Array.from({ length: count }, (_, i) => `2026-03-16-${(i + 1).toString(16).padStart(8, "0")}`);

describe("the drafting and second-read runs in the summary", () => {
  const base = {
    split: "dev" as const,
    final: false,
    startedAt: "2026-10-13T12:00:00.000Z",
    finishedAt: "2026-10-13T12:00:00.000Z",
    commit: "0123456789abcdef0123",
    prompt: "a".repeat(64),
    effort: "low",
    renders: null,
    budgetUsd: 5,
    stoppedAtBudget: false,
  };

  it("gives their measures with counts and intervals, compares two second reads, and nothing from a case", () => {
    const draft: DraftReport = {
      ...base,
      stage: "draft",
      judgePrompt: "b".repeat(64),
      model: "gemini-3.8-flash",
      costUsd: 0.2,
      cases: [
        {
          id: "2026-03-16-8282e9a1",
          split: "dev",
          route: "email",
          outcome: "scored",
          note: "Sam Rivera wrote from jobs@northwind.example.",
          kit: "email",
          answered: 1,
          missing: 1,
          verdicts: { supported: 2 },
          checks: [],
          costUsd: 0.2,
          seconds: 30,
        },
      ],
      gapCoverage: wilson(1, 2),
      verdicts: { supported: 2 },
      checks: {},
    };
    const read = (model: string, right: readonly boolean[]): SecondReadReport => ({
      ...base,
      stage: "address_read",
      model,
      costUsd: 0.12,
      cases: right.map((secondRight, i) => ({
        id: ids(12)[i]!,
        split: "dev",
        route: "email",
        outcome: "scored",
        note: null,
        firstRight: true,
        secondRight,
        agreed: secondRight,
        costUsd: 0.01,
        seconds: 2,
      })),
      agreesWithLabel: wilson(right.filter(Boolean).length, right.length),
      caught: wilson(0, 0),
      falseAlarms: wilson(right.filter((each) => !each).length, right.length),
    });
    const stages = {
      drafts: [draft],
      reads: [
        read("gemini-3.6-flash", Array<boolean>(12).fill(true)),
        read(
          "gemini-3.1-pro",
          Array.from({ length: 12 }, (_, i) => i < 2),
        ),
      ],
    };

    const text = summaryOf([], new Date("2026-10-13T15:00:00Z"), [], stages);

    expect(text).toContain("## draft, gemini-3.8-flash, dev");
    expect(text).toContain("| Must-have gaps answered with a gap line | 1 | 2 | 50% |");
    expect(text).toContain("| supported | 2 |");
    expect(text).toContain("| Second read matches the label | 12 | 12 | 100% |");
    expect(text).toContain(
      "## address_read: gemini-3.1-pro against gemini-3.6-flash on 12 dev cases",
    );
    expect(text).toContain("| 0 | 10 | 0.002 | gemini-3.6-flash |");
    for (const planted of PLANTED) expect(text).not.toContain(planted);
    expect(checkSummary(text, [], [], stages)).toEqual([]);
  });
});

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

  it("shows a synthetic run's checks, what it left to later stages, and the Chrome that rendered its screenshots", () => {
    const cases = [
      post("S09-ai-trap", { company: true, route: true }, [
        { key: "instructions", met: false, note: "include_keyword addressed to AI was not read" },
        { key: "fixed_keys", met: null, note: "Checked when the draft stage is evaluated." },
      ]),
      post("S10-scam", { contact: true }, [{ key: "scam_signals", met: true, note: "" }]),
    ];

    const text = summaryOf(
      [report("claude-opus-5-5", cases, undefined, RENDERS)],
      new Date("2026-10-13T15:00:00Z"),
    );

    expect(text).toContain("## extract, claude-opus-5-5, synthetic");
    expect(text).toContain("Screenshots rendered by Chrome 155.0.8059.40.");
    expect(text).toContain("| company | 1 | 1 | 100% |");
    expect(text).toContain("| role | 0 | 0 | – |");
    expect(text).toContain("| instructions | 0 | 1 | 0% |");
    expect(text).toContain("| scam_signals | 1 | 1 | 100% |");
    expect(text).toContain("Left to later stages: fixed_keys.");
    expect(text).not.toContain("include_keyword addressed to AI");
  });

  it("compares two models' synthetic runs on the fields both scored, leaving out posts read from other screenshots", () => {
    const opus = report(
      "claude-opus-5-5",
      [
        post("S01-email-simple", { company: true, route: true }),
        post("S06-number", { route: false }),
      ],
      undefined,
      RENDERS,
    );
    const sonnet = report(
      "claude-sonnet-5-5",
      [
        post("S01-email-simple", { company: false, route: false }),
        post("S06-number", { route: true }),
      ],
      "2026-10-13T13:00:00.000Z",
      RENDERS,
    );

    const shown = summaryOf([opus, sonnet], new Date("2026-10-13T15:00:00Z"));
    expect(shown).toContain("claude-opus-5-5 against claude-sonnet-5-5 on 2 synthetic cases");
    expect(shown).toMatch(/\| company \| 1 \| 0 \| 1 \| no difference shown \|/);
    expect(shown).toMatch(/\| route \| 1 \| 1 \| 1 \| no difference shown \|/);
    expect(shown).not.toMatch(/\| role \|.*no difference shown/);

    const rerendered = {
      ...sonnet,
      renders: {
        browser: "156.0.7000.12",
        images: { ...RENDERS.images, "S06-number.png": "c".repeat(64) },
      },
    };
    const apart = summaryOf([opus, rerendered], new Date("2026-10-13T15:00:00Z"));
    expect(apart).toContain("claude-opus-5-5 against claude-sonnet-5-5 on 1 synthetic cases");
    expect(apart).toContain(
      "1 more both scored is left out: the runs read different screenshots of it (rendered by Chrome 155.0.8059.40 and Chrome 156.0.7000.12), so a difference there could come from the images.",
    );
    expect(apart).toMatch(/\| route \| 1 \| 0 \| 1 \| no difference shown \|/);
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
      // A report from before checks and renders were recorded.
      write(
        "e",
        JSON.stringify(
          report("claude-sonnet-5-5", [result("2026-03-16-00000002", true)]),
          (key: string, value: unknown) =>
            key === "checks" || key === "renders" ? undefined : value,
        ),
      );

      const reports = readReports(runs);
      expect(reports.map((each) => each.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
      expect(reports[1]).toMatchObject({ checks: {}, renders: null, cases: [{ checks: [] }] });
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
});
