import { NextResponse, type NextRequest } from "next/server";

import { jobStatus } from "@/core/platform/jobs";
import { kindOf } from "@/core/platform/jobStates";
import { claimJob, runJob, type RunnerDeps } from "@/core/platform/runner";
import { isUuid } from "@/lib/uuid";
import type { AppConfig } from "@/server/config";
import { NO_STORE, refusal, sessionForChange } from "@/server/http";

type Deps = RunnerDeps & {
  config: AppConfig;
  /** Next's after() in the app: the pipeline runs once the response has gone. */
  schedule: (task: () => Promise<unknown>) => void;
};

/**
 * POST /api/jobs/<id>/advance (platform spec B9): a page that polls a
 * running job claims its lease here, and the pipeline runs in after()
 * within the route's maximum duration. A second request while the lease is
 * live is refused, so one job never runs twice at once. A job it cannot
 * claim is read as a status read, with its timeouts applied.
 */
export async function advance(
  request: NextRequest,
  deps: Deps,
  jobId: string,
  // When the request reached the route, which the invocation's time limit counts from.
  startedAt: Date = deps.clock.now(),
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (!isUuid(jobId)) return refusal(404, "not-found");
  if (!(await startPipeline(deps, jobId, startedAt))) {
    const job = await jobStatus(deps, jobId);
    if (!job) return refusal(404, "not-found");
    return refusal(409, kindOf(job.state) === "running" ? "claimed" : "not-running");
  }
  return NextResponse.json({ claimed: true }, { status: 202, headers: NO_STORE });
}

/**
 * Claims a running job's lease and schedules the pipeline to run once the
 * response has gone. False when the job is not running or another
 * invocation holds it.
 */
export async function startPipeline(
  deps: RunnerDeps & { schedule: (task: () => Promise<unknown>) => void },
  jobId: string,
  startedAt: Date,
): Promise<boolean> {
  const lease = await claimJob(deps, jobId, { requestedAt: startedAt });
  if (!lease) return false;
  deps.schedule(() => runJob(deps, lease, { startedAt }));
  return true;
}
