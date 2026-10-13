import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { labellingDeps, postAdopt } from "@/server/labelling";

/** Moves a screenshot from the pool into a case (src/server/labelling.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function POST(request: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  const container = await getContainer();
  const { caseId } = await ctx.params;
  return postAdopt(request, labellingDeps(container), caseId);
}
