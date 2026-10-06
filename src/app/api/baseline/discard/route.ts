import type { NextRequest } from "next/server";

import { discard } from "@/server/baseline";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";

export async function POST(request: NextRequest) {
  const { db, clock } = await getContainer();
  return discard(request, { db, clock, config: appConfig() });
}
