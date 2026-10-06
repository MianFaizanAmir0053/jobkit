import type { NextRequest } from "next/server";

import { startGoogleSignIn } from "@/server/auth/google";
import { appConfig } from "@/server/config";

export function GET(request: NextRequest) {
  return startGoogleSignIn(request, { config: appConfig() });
}
