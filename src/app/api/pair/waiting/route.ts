import type { NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { waiting } from "@/server/pairing";

export async function GET(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  return waiting(request, { db, clock, random, config: appConfig() });
}
