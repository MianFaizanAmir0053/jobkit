import { after, type NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { appSendDeps, undo } from "@/server/sendActions";

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/send/undo">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return undo(request, appSendDeps(container, after), id);
}
