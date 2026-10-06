import type { Metadata } from "next";

import { BASELINE_ROUTES, type TimingSummary } from "@/core/ledger/baseline";
import { formatDuration } from "@/lib/time";
import { baselineForViewer, requireSession } from "@/server/dal";

import { ROUTE_NAMES } from "./routeNames";
import { Stopwatch } from "./Stopwatch";

export const metadata: Metadata = { title: "Baseline · jobkit" };

/** The manual baseline before real use (ledger spec, "The timing comparison"). */
export default async function BaselinePage() {
  await requireSession();
  const summary = await baselineForViewer();
  const rows: [string, TimingSummary][] = [
    ["All routes", summary],
    ...BASELINE_ROUTES.map((route): [string, TimingSummary] => [
      ROUTE_NAMES[route],
      summary.byRoute[route],
    ]),
  ];

  return (
    <section aria-labelledby="baseline-heading">
      <h1 id="baseline-heading" className="text-2xl font-semibold tracking-tight">
        Baseline
      </h1>
      <p className="mt-2 text-muted-foreground">
        Time an application done the old way. Tap Start when you have the post in hand, apply as you
        always have, then tap Stop.
      </p>
      {/* A new key per run starts the clock afresh. */}
      <Stopwatch key={summary.running?.id ?? "idle"} elapsedAtLoadMs={summary.runningForMs} />

      <h2 className="mt-8 font-medium">Times so far</h2>
      <table className="mt-2 w-full text-left text-sm">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 font-normal">
              Route
            </th>
            <th scope="col" className="py-1 font-normal">
              Runs
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
          {rows.map(([name, timing]) => (
            <tr key={name} className="border-t border-border">
              <th scope="row" className="py-2 font-normal">
                {name}
              </th>
              <td className="py-2">{timing.count}</td>
              <td className="py-2">
                {timing.medianMs === null ? "–" : formatDuration(timing.medianMs)}
              </td>
              <td className="py-2">{timing.p90Ms === null ? "–" : formatDuration(timing.p90Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-muted-foreground">
        These runs are reported on their own and never enter the comparison with jobkit.
      </p>

      {summary.recent.length > 0 && (
        <>
          <h2 className="mt-8 font-medium">Latest runs</h2>
          <ul className="mt-2 divide-y divide-border text-sm">
            {summary.recent.map((run) => (
              <li key={run.id} className="flex justify-between gap-4 py-2">
                <span>
                  {run.role} at {run.company}
                  <span className="text-muted-foreground"> · {ROUTE_NAMES[run.route!]}</span>
                </span>
                <span className="tabular-nums">{formatDuration(run.durationMs!)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
