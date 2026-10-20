import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { labellingDeps, postJudgeLabel } from "@/server/labelling";

/** Saves one judge-set sentence's label from its page (src/server/labelling.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function POST(request: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  const container = await getContainer();
  const { itemId } = await ctx.params;
  return postJudgeLabel(request, labellingDeps(container), itemId);
}
