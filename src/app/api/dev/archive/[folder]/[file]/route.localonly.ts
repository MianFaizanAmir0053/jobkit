import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { getArchiveImage, labellingDeps } from "@/server/labelling";

/** An image from a case or the pool, for the labelling page (src/server/labelling.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ folder: string; file: string }> },
) {
  const container = await getContainer();
  const { folder, file } = await ctx.params;
  return getArchiveImage(request, labellingDeps(container), folder, file);
}
