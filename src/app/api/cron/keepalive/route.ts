import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { keepalive, readCronSecrets } from "@/server/cron";

export async function GET(request: NextRequest) {
  const { db, clock } = await getContainer();
  return keepalive(request, { db, clock, secrets: readCronSecrets(process.env) });
}
