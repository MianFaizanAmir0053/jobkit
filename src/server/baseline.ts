import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  BASELINE_ROUTES,
  discardBaselineRun,
  startBaselineRun,
  stopBaselineRun,
} from "@/core/ledger/baseline";
import type { Clock, Db } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { jsonBody, NO_STORE, refusal, sessionForChange } from "@/server/http";

/**
 * The Baseline page's stopwatch (ledger spec): any live session may use it,
 * the paired phone included, since the owner may apply from either.
 */
type Deps = { db: Db; clock: Clock; config: AppConfig };

/** POST /api/baseline/start */
export async function start(request: NextRequest, deps: Deps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const started = await startBaselineRun(deps);
  if (!started.ok) return refusal(409, started.reason);
  return NextResponse.json(
    { startedAt: started.run.startedAt.toISOString() },
    { status: 201, headers: NO_STORE },
  );
}

const stopBody = z.object({
  route: z.enum(BASELINE_ROUTES),
  company: z.string().max(1000),
  role: z.string().max(1000),
});

/** POST /api/baseline/stop */
export async function stop(request: NextRequest, deps: Deps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const body = stopBody.safeParse(await jsonBody(request));
  if (!body.success) return refusal(400, "invalid");
  const stopped = await stopBaselineRun(deps, body.data);
  if (!stopped.ok) return refusal(stopped.reason === "invalid" ? 400 : 409, stopped.reason);
  return NextResponse.json({ durationMs: stopped.run.durationMs }, { headers: NO_STORE });
}

/** POST /api/baseline/discard */
export async function discard(request: NextRequest, deps: Deps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  return (await discardBaselineRun(deps))
    ? new NextResponse(null, { status: 204 })
    : refusal(409, "not-running");
}
