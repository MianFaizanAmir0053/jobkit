import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { daily, readCronSecrets } from "@/server/cron";

/** The purges list every job's storage folder: the route has Vercel's full 300 seconds. */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { db, clock, storage } = await getContainer();
  return daily(request, { db, clock, storage, secrets: readCronSecrets(process.env) });
}
