import { NextResponse, type NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { acceptUpload, localRoutesAllowed } from "@/server/devStorage";

/** The local stand-in for Supabase's signed upload URL (src/server/devStorage.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function PUT(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const container = await getContainer();
  if (!localRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const { token } = await ctx.params;
  return acceptUpload(request, container, token);
}
