import { after, type NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { appSendDeps, send, sendState } from "@/server/sendActions";

// What is left of the ten-second countdown, then the delivery's steps, each with its own limit
// (the CV 15 seconds, the token 15, the upload 30), with room for tries again.
export const maxDuration = 120;

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
