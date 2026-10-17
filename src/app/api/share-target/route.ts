import { NextResponse } from "next/server";

import { shareTargetOn } from "@/server/shareTarget";

/**
 * GET /api/share-target: whether the share target takes shares (intake
 * spec, "Share-target switch"), for the service worker, which caches the
 * answer for an hour at most. It says nothing about the owner, so it needs
 * no session.
 */
export function GET() {
  return NextResponse.json({ on: shareTargetOn() }, { headers: { "cache-control": "no-store" } });
}
