import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { gate } from "@/server/jobActions";
import { appPipeline } from "@/server/pipeline";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/gate">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return gate(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    id,
  );
}
