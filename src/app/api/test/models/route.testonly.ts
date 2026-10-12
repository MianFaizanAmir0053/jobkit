import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { setScriptedAnswers } from "@/server/scriptedModels";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Sets the test server's model answers, in the order the stages will ask:
 * { "answers": [ ... ] }. Like the test sign-in route, it exists only in the
 * dev server the end-to-end tests start, and answers only with its
 * in-memory database (platform spec B2).
 */
export async function POST(request: Request) {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { answers?: unknown } | null;
  if (!Array.isArray(body?.answers)) return new NextResponse(null, { status: 400 });
  setScriptedAnswers(body.answers);
  return new NextResponse(null, { status: 204 });
}
