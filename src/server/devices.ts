import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { revokeSession } from "@/core/platform/devices";
import type { Clock, Db } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import { jsonBody, refusal, sessionForChange } from "@/server/http";

const revokeBody = z.object({ sessionId: z.uuid() });

/**
 * POST /api/devices/revoke (platform spec B2): a google session deletes
 * another session's row, so that session's next request is refused.
 */
export async function revoke(
  request: NextRequest,
  deps: { db: Db; clock: Clock; config: AppConfig },
): Promise<NextResponse> {
  const actor = await sessionForChange(request, deps);
  if (!actor.ok) return actor.response;
  if (actor.session.kind !== "google") return refusal(403, "wrong-kind");
  const body = revokeBody.safeParse(await jsonBody(request));
  if (!body.success) return refusal(400, "bad-request");
  const revoked = await revokeSession(deps, actor.session, body.data.sessionId);
  return revoked ? new NextResponse(null, { status: 204 }) : refusal(404, "not-found");
}
