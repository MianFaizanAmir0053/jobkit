import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { setShareTargetForTests } from "@/server/shareTarget";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Sets the share target's switch for the end-to-end tests: { "on": false }
 * turns it off until the next reset. Like the test sign-in route, it exists
 * only in the dev server those tests start, and answers only with its
 * in-memory database.
 */
export async function POST(request: Request) {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return new NextResponse(null, { status: 400 });
  setShareTargetForTests(body.on);
  return new NextResponse(null, { status: 204 });
}
