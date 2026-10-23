import type { NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { testMode } from "@/server/measurement";

export async function POST(request: NextRequest) {
  const { db, clock } = await getContainer();
  return testMode(request, { db, clock, config: appConfig() });
}
