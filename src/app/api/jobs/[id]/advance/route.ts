import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { advance } from "@/server/jobs";
import { appPipeline } from "@/server/pipeline";

/** after() runs within the route's maximum duration, so the pipeline gets Vercel's 300 seconds (B9). */
export const maxDuration = 300;

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/advance">) {
  // The invocation's time limit counts from here, before the container and the claim.
  // The system clock, which is the container's clock in the app.
  const startedAt = new Date();
  const { db, clock } = await getContainer();
  const { id } = await ctx.params;
  return advance(
    request,
    { db, clock, config: appConfig(), pipeline: appPipeline(), schedule: after },
    id,
    startedAt,
  );
}
