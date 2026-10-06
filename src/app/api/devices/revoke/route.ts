import type { NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { revoke } from "@/server/devices";

export async function POST(request: NextRequest) {
  const { db, clock } = await getContainer();
  return revoke(request, { db, clock, config: appConfig() });
}
