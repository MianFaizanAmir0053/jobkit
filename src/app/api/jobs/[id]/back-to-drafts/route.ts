import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { backToDrafts } from "@/server/jobActions";
import { appPipeline } from "@/server/pipeline";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]/back-to-drafts">,
) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return backToDrafts(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    id,
  );
}
