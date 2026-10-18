import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Logs one model call costing { "usd": n } this month, so the end-to-end
 * tests can reach the spend cap (ledger spec); the next reset deletes it.
 * Like the test sign-in route, it exists only in the dev server those tests
 * start, and answers only with its in-memory database.
 */
export async function POST(request: Request) {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { usd?: unknown } | null;
  if (typeof body?.usd !== "number" || !(body.usd > 0)) {
    return new NextResponse(null, { status: 400 });
  }
  await container.db.query(
    `insert into {{schema}}.model_calls
       (stage, attempt, provider, requested_model, started_at, outcome, cost_usd,
        cost_provisional, price_known)
     values ('extract', 1, 'gemini', 'gemini-3.8-flash', $1, 'ok', $2, false, true)`,
    [container.clock.now(), body.usd],
  );
  return new NextResponse(null, { status: 204 });
}
