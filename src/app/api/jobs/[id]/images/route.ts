import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { images } from "@/server/jobActions";
import { appPipeline } from "@/server/pipeline";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/images">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return images(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    id,
  );
}
