import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { labellingDeps, postLabels } from "@/server/labelling";

/** Saves a case's labels from the labelling page (src/server/labelling.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function POST(request: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  const container = await getContainer();
  const { caseId } = await ctx.params;
  return postLabels(request, labellingDeps(container), caseId);
}
