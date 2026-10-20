import type { Metadata } from "next";

import { isStageName } from "@/core/platform/jobStates";
import { requireSession, spendForViewer } from "@/server/dal";

import { STAGE_NAMES } from "../stageNames";

export const metadata: Metadata = { title: "Spend · jobkit" };

const usd = (value: number) => `$${value.toFixed(2)}`;

/** The Spend page (ledger spec, "Spend cap"): this UTC month's model spend. */
export default async function SpendPage() {
  await requireSession();
  const report = await spendForViewer();
  const { limits } = report;

  return (
    <section aria-labelledby="spend-heading" className="flex flex-col gap-6">
      <div>
        <h1 id="spend-heading" className="text-2xl font-semibold tracking-tight">
          Spend
        </h1>
        <p className="mt-2 text-muted-foreground">This month, in UTC, as the cap counts it.</p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-3xl font-semibold tabular-nums">{usd(report.monthToDateUsd)}</p>
        <p className="text-sm text-muted-foreground">
          New jobs stop at {usd(limits.newJobsUsd)} and every model call at {usd(limits.callsUsd)};
          a warning shows from {usd(limits.warnUsd)}.
        </p>
        {report.provisionalUsd > 0 && (
          <p className="text-sm">
            {usd(report.provisionalUsd)} of it is an upper bound: calls that ended without saying
            what they used are counted at the most they could have cost.
          </p>
        )}
        {report.unknownPriceCalls > 0 && (
          <p className="text-sm text-destructive">
            {report.unknownPriceCalls === 1 ? "One call" : `${report.unknownPriceCalls} calls`} went
            to a model missing from jobkit&apos;s price table, counted at the highest rates: add its
            prices to src/core/platform/prices.ts.
          </p>
        )}
      </div>

      <p className="text-sm">
        {report.medianPerJobUsd === null
          ? "No job has called a model this month."
          : `A job costs ${usd(report.medianPerJobUsd)} at the median, over ${report.jobs} ${report.jobs === 1 ? "job" : "jobs"} this month.`}
      </p>

      {report.byStage.length > 0 && (
        <div>
          <h2 className="font-medium">Each step</h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-normal">
                  Step
                </th>
                <th scope="col" className="py-1 font-normal">
                  Calls
                </th>
                <th scope="col" className="py-1 font-normal">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {report.byStage.map((stage) => (
                <tr key={stage.stage} className="border-t border-border">
                  <th scope="row" className="py-2 font-normal">
                    {isStageName(stage.stage) ? STAGE_NAMES[stage.stage] : stage.stage}
                  </th>
                  <td className="py-2">{stage.calls}</td>
                  <td className="py-2">{usd(stage.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
