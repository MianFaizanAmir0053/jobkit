import { join } from "node:path";

import { NextResponse } from "next/server";

import { seedProfile } from "@/core/profile/seed";
import { getContainer } from "@/server/container";
import { loadProfileFile } from "@/server/profileFile";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Seeds the public sample profile into the test database, for the
 * end-to-end tests. Like the test sign-in route, it exists only in the dev
 * server those tests start, and answers only with the in-memory database.
 */
export async function POST() {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const checked = loadProfileFile(join(process.cwd(), "evals", "synthetic", "profile.sample.yaml"));
  if (!checked.ok) return NextResponse.json(checked.problems, { status: 500 });
  await seedProfile(container, checked);
  return new NextResponse(null, { status: 204 });
}
