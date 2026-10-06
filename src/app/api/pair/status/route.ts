import type { NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { status } from "@/server/pairing";

export async function GET(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  return status(request, { db, clock, random, config: appConfig() });
}
