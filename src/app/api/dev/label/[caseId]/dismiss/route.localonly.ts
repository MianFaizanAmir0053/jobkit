import type { NextRequest } from "next/server";

import { getContainer } from "@/server/container";
import { labellingDeps, postDismiss } from "@/server/labelling";

/** Sets a case aside as not an application (src/server/labelling.ts). */
// Typed by hand: next typegen leaves local-only routes out, as every build does.
export async function POST(request: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  const container = await getContainer();
  const { caseId } = await ctx.params;
  return postDismiss(request, labellingDeps(container), caseId);
}
