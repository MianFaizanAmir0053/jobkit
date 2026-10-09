import type { NextConfig } from "next";

import { onVercelDeployment } from "./src/server/deployEnv";

// Test-only routes (files named route.testonly.ts or page.testonly.tsx, only
// under /api/test/ and /test/) exist only in the dev server the end-to-end
// tests start with JOBKIT_ENV=test (platform spec B2). `next dev` sets
// NODE_ENV to development before reading this file, and a build to
// production unless the shell presets another value; requiring development
// keeps them out of every build either way. scripts/checkBuild.ts checks
// every build too.
const testOnly =
  process.env.JOBKIT_ENV === "test" &&
  process.env.NODE_ENV === "development" &&
  !onVercelDeployment(process.env)
    ? ["testonly.ts", "testonly.tsx"]
    : [];

const nextConfig: NextConfig = {
  pageExtensions: ["tsx", "ts", "jsx", "js", ...testOnly],
  // PGlite finds its WebAssembly files with new URL(…, import.meta.url), which
  // breaks once Turbopack bundles it: a persistent database (JOBKIT_ENV=
  // development) then fails to open. Node's own import keeps the URLs right.
  // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md
  serverExternalPackages: ["@electric-sql/pglite"],
  // The headers Next's PWA guide recommends (docs/runbook/next16-notes.md).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // No other site may frame a page, so none can overlay the Approve button.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
