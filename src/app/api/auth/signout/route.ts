import type { NextRequest } from "next/server";

import { signOut } from "@/server/auth/signOut";
import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";

export async function POST(request: NextRequest) {
  const { db } = await getContainer();
  return signOut(request, { db, config: appConfig() });
}
