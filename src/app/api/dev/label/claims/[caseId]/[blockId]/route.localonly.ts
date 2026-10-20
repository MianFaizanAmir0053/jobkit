import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { labellingDeps, postClaimLabel } from "@/server/labelling";

/** Saves one live claim's label from its page (src/server/labelling.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ caseId: string; blockId: string }> },
) {
  const container = await getContainer();
  const { caseId, blockId } = await ctx.params;
  return postClaimLabel(request, labellingDeps(container), caseId, blockId);
}
