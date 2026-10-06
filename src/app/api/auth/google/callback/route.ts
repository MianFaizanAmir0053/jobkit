import type { NextRequest } from "next/server";

import { finishGoogleSignIn } from "@/server/auth/google";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";

export async function GET(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  return finishGoogleSignIn(request, { db, clock, random, config: appConfig() });
}
