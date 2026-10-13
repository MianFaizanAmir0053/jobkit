/**
 *   npm run build   runs `next build`, then this check
 *
 * Platform spec B2: test-only routes exist only in the dev server the
 * end-to-end tests start, and the local-only routes and pages (the storage
 * stand-ins, the labelling page) only in a dev server with a local
 * database, never in a build. next.config.ts leaves them
 * out of every build; this confirms it from the build's own route manifest,
 * and fails the build (on Vercel too) if one slipped in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only routes live under these paths and nowhere else.
export const TEST_ONLY_PREFIXES = ["/api/test/", "/test/"];

// Local-only routes and pages: the local storage adapter's stand-ins for Supabase's signed
// URLs, and the evaluation's labelling page (evals AC2: a build has no /dev/label).
export const LOCAL_ONLY_PREFIXES = ["/api/dev/", "/dev/"];

/** A route under a prefix, or at the prefix itself: "/api/dev" is as local-only as "/api/dev/x". */
export function isUnder(route: string, prefix: string): boolean {
  if (!prefix.endsWith("/")) throw new Error(`A prefix must end with a slash: ${prefix}`);
  return route.startsWith(prefix) || route === prefix.slice(0, -1);
}

export function checkBuildRoutes(
  manifest: Readonly<Record<string, string>>,
): { ok: true } | { ok: false; routes: string[] } {
  const routes = Object.values(manifest).filter((route) =>
    [...TEST_ONLY_PREFIXES, ...LOCAL_ONLY_PREFIXES].some((prefix) => isUnder(route, prefix)),
  );
  return routes.length === 0 ? { ok: true } : { ok: false, routes };
}

function main(): number {
  const manifestPath = join(process.cwd(), ".next", "app-path-routes-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
  const result = checkBuildRoutes(manifest);
  if (result.ok) return 0;
  console.error(
    `This build contains routes only a dev server may have: ${result.routes.join(", ")}.`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
