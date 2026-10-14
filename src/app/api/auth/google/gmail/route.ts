import type { NextRequest } from "next/server";

import { startGmailConnect } from "@/server/auth/gmailConnect";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { gmailTokenKey } from "@/server/gmail/key";

/** GET /api/auth/google/gmail: connect the owner's Gmail for one-click send (decisions A20). */
export async function GET(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  return startGmailConnect(request, {
    db,
    clock,
    random,
    config: appConfig(),
    key: gmailTokenKey(),
  });
}
