import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { resetTestGmail, testGmail } from "@/server/gmail/sender";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * The test server's Gmail (decisions A20): POST { "connected": true }
 * connects it, as the owner would on the Devices page, with a fake that
 * sends nothing, and { "connected": false } disconnects it; "failWith"
 * makes every later send fail with that message: not sent, or, with
 * "reason": "unknown", a send that may have gone. GET gives the messages it
 * was given. Like the test sign-in route, it exists only in the dev
 * server the end-to-end tests start, and answers only with its in-memory
 * database (platform spec B2).
 */
export async function POST(request: Request) {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    connected?: unknown;
    failWith?: unknown;
    reason?: unknown;
  } | null;
  if (typeof body?.connected !== "boolean") return new NextResponse(null, { status: 400 });
  if (body.reason !== undefined && body.reason !== "unknown") {
    return new NextResponse(null, { status: 400 });
  }
  resetTestGmail();
  if (typeof body.failWith === "string") {
    const reason = body.reason === "unknown" ? "unknown" : "failed";
    testGmail().answerWith({ ok: false, reason, message: body.failWith });
  }
  await container.db.query("delete from {{schema}}.gmail_connection");
  if (body.connected) {
    await container.db.query(
      `insert into {{schema}}.gmail_connection (id, email, refresh_token_sealed, scopes, connected_at)
       values (1, 'owner@example.com', 'not a token', '{}', $1)`,
      [container.clock.now()],
    );
  }
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json({ sent: testGmail().sent });
}
