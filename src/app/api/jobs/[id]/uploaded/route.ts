import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { confirm } from "@/server/intake";
import { appPipeline } from "@/server/pipeline";

/** Confirming an upload starts the pipeline in after(), within the route's 300 seconds (B9). */
export const maxDuration = 300;

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/uploaded">) {
  // The invocation's time limit counts from here; the system clock is the container's in the app.
  const startedAt = new Date();
  const container = await getContainer();
  const { id } = await ctx.params;
  return confirm(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(), schedule: after },
    id,
    startedAt,
  );
}
