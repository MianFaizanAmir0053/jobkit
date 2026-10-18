import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { again } from "@/server/intake";
import { appPipeline } from "@/server/pipeline";

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/upload-again">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return again(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    id,
  );
}
