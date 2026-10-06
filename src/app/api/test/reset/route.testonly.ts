import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";

/**
 * Empties the test database between end-to-end tests. Like the test sign-in
 * route, only JOBKIT_ENV=test builds contain it, and it refuses any container
 * but the in-memory test one.
 */
export async function POST() {
  const container = await getContainer();
  if (container.kind !== "test") return new NextResponse(null, { status: 404 });
  // Deleting the sessions deletes their pairing tokens and approvals too.
  await container.db.exec("delete from {{schema}}.sessions; delete from {{schema}}.owner;");
  return new NextResponse(null, { status: 204 });
}
