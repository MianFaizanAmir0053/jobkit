import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { setScriptedAnswers } from "@/server/scriptedModels";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Sets the test server's model answers, each model's in the order its
 * stages will ask: { "answers": { "<model>": [ ... ], ... } }, such as the
 * post, the draft and the verdicts for the stages' model and the contact
 * for the second read's. Like the test sign-in route, it exists only in the
 * dev server the end-to-end tests start, and answers only with its
 * in-memory database (platform spec B2).
 */
export async function POST(request: Request) {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { answers?: unknown } | null;
  const answers = body?.answers;
  if (
    typeof answers !== "object" ||
    answers === null ||
    Array.isArray(answers) ||
    !Object.values(answers).every(Array.isArray)
  ) {
    return new NextResponse(null, { status: 400 });
  }
  setScriptedAnswers(answers as Record<string, unknown[]>);
  return new NextResponse(null, { status: 204 });
}
