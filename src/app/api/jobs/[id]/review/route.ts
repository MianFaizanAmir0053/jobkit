import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { review } from "@/server/jobActions";
import { appPipeline } from "@/server/pipeline";

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/review">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return review(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    id,
  );
}
