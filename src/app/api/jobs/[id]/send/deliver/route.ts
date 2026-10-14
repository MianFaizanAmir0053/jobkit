import { after, type NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { appSendDeps, deliver } from "@/server/sendActions";

// What is left of the ten-second countdown, then Gmail answers within 30 seconds.
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]/send/deliver">,
) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return deliver(request, appSendDeps(container, after), id);
}
