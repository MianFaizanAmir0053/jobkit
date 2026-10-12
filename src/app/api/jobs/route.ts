import { after, type NextRequest } from "next/server";

import { appConfig } from "@/server/config";
import { getContainer } from "@/server/container";
import { create } from "@/server/intake";
import { appPipeline } from "@/server/pipeline";

/** A paste-only job starts its pipeline here, in after(), so the route gets Vercel's 300 seconds (B9). */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // The invocation's time limit counts from here; the system clock is the container's in the app.
  const startedAt = new Date();
  const container = await getContainer();
  return create(
    request,
    { ...container, config: appConfig(), pipeline: appPipeline(container), schedule: after },
    startedAt,
  );
}
