import type { NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { redeem } from "@/server/pairing";

export async function POST(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  return redeem(request, { db, clock, random, config: appConfig() });
}
