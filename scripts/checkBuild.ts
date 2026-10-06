/**
 *   npm run build   runs `next build`, then this check
 *
 * Platform spec B2: the test sign-in route exists only in builds made with
 * JOBKIT_ENV=test, so a production build cannot contain it. next.config.ts
 * leaves such routes out of other builds; this confirms it from the build's
 * own route manifest, and fails the build (on Vercel too) if one slipped in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only routes live under these paths and nowhere else.
const TEST_ONLY_PREFIXES = ["/api/test/", "/test/"];

export function checkBuildRoutes(
  manifest: Readonly<Record<string, string>>,
  jobkitEnv: string | undefined,
): { ok: true } | { ok: false; routes: string[] } {
  if (jobkitEnv === "test") return { ok: true };
  const routes = Object.values(manifest).filter((route) =>
    TEST_ONLY_PREFIXES.some((prefix) => route.startsWith(prefix)),
  );
  return routes.length === 0 ? { ok: true } : { ok: false, routes };
}

function main(): number {
  const manifestPath = join(process.cwd(), ".next", "app-path-routes-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
  const result = checkBuildRoutes(manifest, process.env.JOBKIT_ENV);
  if (result.ok) return 0;
  console.error(
    `This build contains test-only routes (${result.routes.join(", ")}), but JOBKIT_ENV is not test.`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
