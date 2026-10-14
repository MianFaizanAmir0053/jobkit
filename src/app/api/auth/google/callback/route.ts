import type { NextRequest } from "next/server";

import { finishGmailConnect, isGmailCallback } from "@/server/auth/gmailConnect";
import { finishGoogleSignIn } from "@/server/auth/google";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { gmailTokenKey } from "@/server/gmail/key";

export async function GET(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  // Connecting Gmail returns here too, so Google needs no second redirect URI.
  if (isGmailCallback(request)) {
    return finishGmailConnect(request, {
      db,
      clock,
      random,
      config: appConfig(),
      key: gmailTokenKey(),
    });
  }
  return finishGoogleSignIn(request, { db, clock, random, config: appConfig() });
}
