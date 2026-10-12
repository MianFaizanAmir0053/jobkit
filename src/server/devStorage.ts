import { NextResponse, type NextRequest } from "next/server";

import type { LocalStorage } from "@/adapters/localStorage";
import type { Storage } from "@/core/ports";
import type { Container } from "@/server/container";
import { onVercelDeployment } from "@/server/deployEnv";

/**
 * The routes the local storage adapter's signed URLs point at: on the laptop
 * they stand in for Supabase Storage, so the browser uploads each image
 * straight to "storage" and reads it back through a short-lived link, as it
 * will in production. They are files named route.localonly.ts under
 * /api/dev/, which next.config.ts includes only in a dev server with a local
 * database and scripts/checkBuild.ts refuses in any build; this is the
 * second lock.
 */

type Deps = { storage: Storage; kind: Container["kind"] };

const TYPES: Readonly<Record<string, string>> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
};

export function localRoutesAllowed(
  env: Readonly<Record<string, string | undefined>>,
  kind: Container["kind"],
): boolean {
  return env.NODE_ENV === "development" && !onVercelDeployment(env) && kind !== "production";
}

function local(deps: Deps): LocalStorage | null {
  return deps.kind !== "production" && "acceptSignedUpload" in deps.storage
    ? (deps.storage as LocalStorage)
    : null;
}

/** PUT /api/dev/storage/upload/<token>: stores the file the token was issued for, once. */
export async function acceptUpload(
  request: NextRequest,
  deps: Deps,
  token: string,
): Promise<NextResponse> {
  const storage = local(deps);
  if (!storage) return new NextResponse(null, { status: 404 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const stored = await storage.acceptSignedUpload(token, bytes);
  return new NextResponse(null, { status: stored ? 200 : 404 });
}

/** GET /api/dev/storage/read/<token>: the file the token stands for, until it expires. */
export async function serveRead(deps: Deps, token: string): Promise<NextResponse> {
  const storage = local(deps);
  // The adapter stamps read links with the system's time, as Supabase does.
  const path = storage?.resolveSignedRead(token, Date.now()) ?? null;
  const bytes = path === null ? null : await storage!.get(path);
  if (path === null || bytes === null) return new NextResponse(null, { status: 404 });
  const type = TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";
  return new NextResponse(bytes as BodyInit, {
    headers: { "Content-Type": type, "Cache-Control": "private, no-store" },
  });
}
