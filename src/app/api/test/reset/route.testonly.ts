import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Empties the test database between end-to-end tests. Like the test sign-in
 * route, it exists only in the dev server those tests start, and answers only
 * with the in-memory test database.
 */
export async function POST() {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  // Deleting the sessions deletes their pairing tokens and approvals too.
  await container.db.exec(`
    delete from {{schema}}.sessions;
    delete from {{schema}}.owner;
    delete from {{schema}}.baseline_runs;
    delete from {{schema}}.profile_versions;
  `);
  return new NextResponse(null, { status: 204 });
}
