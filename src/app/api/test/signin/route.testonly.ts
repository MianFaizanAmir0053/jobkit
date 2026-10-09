import { NextResponse } from "next/server";

import { issueSession, remainingSeconds } from "@/core/platform/sessions";
import { getContainer } from "@/server/container";
import { testRoutesAllowed } from "@/server/testOnly";
import { sessionCookie } from "@/server/sessionCookie";

/**
 * A stand-in for Google sign-in, for the end-to-end tests (platform spec B2).
 * Only builds made with JOBKIT_ENV=test treat this file as a route
 * (next.config.ts), and scripts/checkBuild.ts fails any other build that
 * contains it. It also refuses to run against anything but the test
 * container, whose database lives in memory.
 */
export async function POST() {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const issued = await issueSession(container, { kind: "google", label: "Test browser" });
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(
    sessionCookie(issued.token, remainingSeconds(issued.session, container.clock.now())),
  );
  return response;
}
