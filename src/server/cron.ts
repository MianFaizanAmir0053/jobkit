import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { dailyMaintenance, keepAlive } from "@/core/platform/maintenance";
import type { Clock, Db } from "@/core/ports";
import { NO_STORE } from "@/server/http";

/**
 * The scheduled endpoints (platform spec B6). Each accepts only its own
 * secret, sent as `Authorization: Bearer <secret>`, which is how Vercel's
 * cron sends CRON_SECRET: https://vercel.com/docs/cron-jobs/manage-cron-jobs
 * The keep-alive secret lives in GitHub, so it can only touch the heartbeat.
 */
export interface CronSecrets {
  cron: string;
  keepalive: string;
}

type Deps = { db: Db; clock: Clock; secrets: CronSecrets };

export function readCronSecrets(env: Readonly<Record<string, string | undefined>>): CronSecrets {
  return { cron: env.CRON_SECRET ?? "", keepalive: env.KEEPALIVE_SECRET ?? "" };
}

/** GET /api/cron/keepalive, called by GitHub Actions every 8 hours. */
export async function keepalive(request: NextRequest, deps: Deps): Promise<NextResponse> {
  if (!authorised(request, deps.secrets.keepalive, deps.secrets)) return unauthorised();
  await keepAlive(deps);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

/** GET /api/cron/daily, called by Vercel's cron once a day. */
export async function daily(request: NextRequest, deps: Deps): Promise<NextResponse> {
  if (!authorised(request, deps.secrets.cron, deps.secrets)) return unauthorised();
  return NextResponse.json(await dailyMaintenance(deps), { headers: NO_STORE });
}

/**
 * An unset secret admits nobody, and so do two equal secrets, since each
 * endpoint must refuse the other's. Both sides are hashed to equal lengths,
 * so the comparison takes the same time whatever was sent.
 */
function authorised(request: NextRequest, secret: string, all: CronSecrets): boolean {
  const sent = request.headers.get("authorization");
  if (!secret || all.cron === all.keepalive || sent === null) return false;
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(sent), digest(`Bearer ${secret}`));
}

function unauthorised(): NextResponse {
  return new NextResponse("Unauthorized", { status: 401, headers: NO_STORE });
}
