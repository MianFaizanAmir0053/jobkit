import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { setTestMode } from "@/core/ledger/testMode";
import type { Clock, Db } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { jsonBody, NO_STORE, refusal, sessionForChange } from "@/server/http";

/**
 * Test mode (ledger spec, "Test jobs"): any live session may turn it on or
 * off, the paired phone's included, since device checks run on the phone.
 */
type Deps = { db: Db; clock: Clock; config: AppConfig };

const testModeBody = z.object({ on: z.boolean() });

/** POST /api/measurement/test-mode: turns test mode on for an hour, or off. */
export async function testMode(request: NextRequest, deps: Deps): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  const body = testModeBody.safeParse(await jsonBody(request));
  if (!body.success) return refusal(400, "invalid");
  const until = await setTestMode(deps, body.data.on);
  return NextResponse.json({ until: until?.toISOString() ?? null }, { headers: NO_STORE });
}
