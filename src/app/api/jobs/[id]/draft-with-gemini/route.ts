import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { geminiDraft } from "@/server/jobActions";
import { appPipeline } from "@/server/pipeline";

/** The job runs again in after(), within the route's 300 seconds (B9). */
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]/draft-with-gemini">,
) {
  // The invocation's time limit counts from here; the system clock is the container's in the app.
  const startedAt = new Date();
  const container = await getContainer();
  const { id } = await ctx.params;
  return geminiDraft(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    id,
    startedAt,
  );
}
