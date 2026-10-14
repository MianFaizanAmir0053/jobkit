import type { NextRequest } from "next/server";

import { disconnectGmail } from "@/server/auth/gmailConnect";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { gmailTokenKey } from "@/server/gmail/key";

/** POST /api/gmail/disconnect: forget the Gmail connection and revoke its token. */
export async function POST(request: NextRequest) {
  const { db, clock, random } = await getContainer();
  return disconnectGmail(request, { db, clock, random, config: appConfig(), key: gmailTokenKey() });
}
