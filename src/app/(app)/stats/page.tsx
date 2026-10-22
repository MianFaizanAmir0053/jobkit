import type { Metadata } from "next";
import Link from "next/link";

import { BASELINE_ROUTES } from "@/core/ledger/baseline";
import type { Interval } from "@/core/ledger/bootstrap";
import { type ArmComparison, COMPARISON_MIN, type Spread } from "@/core/ledger/statsReport";
import { formatDuration } from "@/lib/time";
import { requireSession, statsForViewer, viewerTimeZone } from "@/server/dal";

import { ROUTE_NAMES } from "../baseline/routeNames";
import { formatTime } from "../jobs/words";
import { STAGE_NAMES } from "../stageNames";

export const metadata: Metadata = { title: "Stats · jobkit" };

const time = (ms: number | null) => (ms === null ? "–" : formatDuration(ms));
const percent = (share: number) => `${Math.round(share * 100)}%`;
const between = (interval: Interval | null, show: (value: number) => string) =>
  interval ? ` (95% interval ${show(interval.low)} to ${show(interval.high)})` : "";

/** The Stats page (ledger spec, "Timing and stats"): real jobs only. */
export default async function StatsPage() {
  await requireSession();
  const report = await statsForViewer();
  const timeZone = await viewerTimeZone();
  const routes = [
    ["All routes", "pooled"] as const,
    ...BASELINE_ROUTES.map((route) => [ROUTE_NAMES[route], route] as const),
  ];
  const spreadOf = (table: typeof report.machine, key: (typeof routes)[number][1]): Spread =>
    key === "pooled" ? table.pooled : table.byRoute[key];
  const comparisonOf = (key: (typeof routes)[number][1]): ArmComparison =>
    key === "pooled" ? report.comparison.pooled : report.comparison.byRoute[key];

  return (
    <section aria-labelledby="stats-heading" className="flex flex-col gap-8">
      <div>
        <h1 id="stats-heading" className="text-2xl font-semibold tracking-tight">
          Stats
        </h1>
        <p className="mt-2 text-muted-foreground">
          Real jobs only.{" "}
          {report.realUseSince
            ? `Real use started ${formatTime(report.realUseSince, timeZone)}.`
            : "Real use starts at your first handoff of a kit jobkit made."}
        </p>
      </div>

      {(
        [
          [
            "Machine time",
            "From the job's start to its kit, waiting for you left out.",
            report.machine,
          ],
          ["Total time", "From the job's start until it went.", report.total],
        ] as const
      ).map(([title, about, table]) => (
        <div key={title}>
          <h2 className="font-medium">{title}</h2>
          <p className="text-sm text-muted-foreground">{about}</p>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-normal">
                  Route
                </th>
                <th scope="col" className="py-1 font-normal">
                  Jobs
                </th>
                <th scope="col" className="py-1 font-normal">
                  Median
                </th>
                <th scope="col" className="py-1 font-normal">
                  90th percentile
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {routes.map(([name, key]) => {
                const row = spreadOf(table, key);
                return (
                  <tr key={name} className="border-t border-border">
                    <th scope="row" className="py-2 font-normal">
                      {name}
                    </th>
                    <td className="py-2">{row.count}</td>
                    <td className="py-2">{time(row.medianMs)}</td>
                    <td className="py-2">{time(row.p90Ms)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div>
        <h2 className="font-medium">Each step</h2>
        {report.stages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No step has run for a real job yet.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-normal">
                  Step
                </th>
                <th scope="col" className="py-1 font-normal">
                  Runs
                </th>
                <th scope="col" className="py-1 font-normal">
                  Median
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {report.stages.map((stage) => (
                <tr key={stage.stage} className="border-t border-border">
                  <th scope="row" className="py-2 font-normal">
                    {STAGE_NAMES[stage.stage]}
                  </th>
                  <td className="py-2">{stage.runs}</td>
                  <td className="py-2">{time(stage.medianMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-medium">Routes and uploads</h2>
        <p>
          {BASELINE_ROUTES.map((route) => `${ROUTE_NAMES[route]}: ${report.routeMix[route]}`).join(
            " · ",
          )}
        </p>
        <p>
          {report.uploads.rate === null
            ? "No upload has ended yet."
            : `${report.uploads.ok} of ${report.uploads.ok + report.uploads.failed} uploads arrived (${percent(report.uploads.rate)}).`}
        </p>
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-medium">Factual edits</h2>
        <p>
          {report.factualEdits.rate === null
            ? "No email has gone yet."
            : `${report.factualEdits.edits} of ${report.factualEdits.outcomes} emails had a factual edit: ${percent(report.factualEdits.rate)}${between(report.factualEdits.interval, percent)}.`}
        </p>
        <p>
          {report.judgeFalsePositives.kits === 0
            ? "No kit that went has a sentence you checked past the separate check yet."
            : `${report.judgeFalsePositives.sentences} ${report.judgeFalsePositives.sentences === 1 ? "sentence" : "sentences"} the separate check held went unchanged after "I checked this", over ${report.judgeFalsePositives.kits} ${report.judgeFalsePositives.kits === 1 ? "kit" : "kits"}: its false positives.`}
        </p>
        <p>
          The trust gate is {report.trustGate.unlocked ? "unlocked" : "locked"}:{" "}
          {report.trustGate.cleanStreak} clean in a row, {report.trustGate.needed} unlock it.
        </p>
        <p className="text-muted-foreground">
          A streak of ten can come by chance even when about one email in four needs a factual edit:
          the rate is the measure, the streak a gate.
        </p>
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-medium">jobkit against the old way</h2>
        {report.realUseSince === null ? (
          <p className="text-muted-foreground">The comparison starts with real use.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {routes.map(([name, key]) => {
              const row = comparisonOf(key);
              const min = key === "pooled" ? COMPARISON_MIN.pooled : COMPARISON_MIN.route;
              return (
                <li key={name}>
                  <span className="font-medium">{name}: </span>
                  {row.shown ? (
                    <>
                      with jobkit {time(row.tool.medianMs)}
                      {between(row.tool.interval, formatDuration)}, the old way{" "}
                      {time(row.manual.medianMs)}
                      {between(row.manual.interval, formatDuration)}
                      {row.ratio !== null &&
                        `; the old way takes ${row.ratio.toFixed(1)} times as long${between(row.ratioInterval, (value) => value.toFixed(1))}`}
                      .
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      shown from {min} runs in each arm (with jobkit {row.tool.count}, the old way{" "}
                      {row.manual.count}).
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-muted-foreground">
          Runs timed before real use are on the <Link href="/baseline">Baseline</Link> page, and
          never enter this comparison.
        </p>
      </div>
    </section>
  );
}
