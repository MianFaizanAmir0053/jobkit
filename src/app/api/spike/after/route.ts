import { after, NextResponse, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { sessionForChange } from "@/server/http";

/**
 * Task 8's spike: the pipeline will run its stages in after(), which runs
 * within the route's maximum duration. Vercel Hobby with Fluid compute allows
 * 300 seconds; this run lasts 200 and logs as it goes, so the logs show
 * whether it finishes. Removed once the result is recorded.
 */
export const maxDuration = 300;

const RUN_SECONDS = 200;

export async function POST(request: NextRequest) {
  const { db, clock } = await getContainer();
  const actor = await sessionForChange(request, { db, clock, config: appConfig() });
  if (!actor.ok) return actor.response;
  const started = Date.now();
  after(async () => {
    console.log("spike after(): started");
    for (let elapsed = 50; elapsed <= RUN_SECONDS; elapsed += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50_000));
      console.log(`spike after(): ${elapsed} s`);
    }
    console.log(`spike after(): finished after ${Math.round((Date.now() - started) / 1000)} s`);
  });
  return NextResponse.json(
    { started: new Date(started).toISOString(), seconds: RUN_SECONDS },
    { status: 202 },
  );
}
