import { after, type NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { appSendDeps, send, sendState } from "@/server/sendActions";

// The delivery waits out the ten-second countdown, then Gmail answers within 30 seconds.
export const maxDuration = 60;

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/send">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return send(request, appSendDeps(container, after), id);
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/send">) {
  const container = await getContainer();
  const { id } = await ctx.params;
  return sendState(request, appSendDeps(container, after), id);
}
