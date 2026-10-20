import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { daily, readCronSecrets } from "@/server/cron";

export async function GET(request: NextRequest) {
  const { db, clock, storage } = await getContainer();
  return daily(request, { db, clock, storage, secrets: readCronSecrets(process.env) });
}
