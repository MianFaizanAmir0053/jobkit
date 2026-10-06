import type { NextRequest } from "next/server";

import { start } from "@/server/baseline";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";

export async function POST(request: NextRequest) {
  const { db, clock } = await getContainer();
  return start(request, { db, clock, config: appConfig() });
}
