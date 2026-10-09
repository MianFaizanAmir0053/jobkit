import type { NextConfig } from "next";

// Test-only routes (files named route.testonly.ts or page.testonly.tsx, under
// /api/test/ and /test/) exist only in the dev server the end-to-end tests
// start with JOBKIT_ENV=test (platform spec B2). Next sets NODE_ENV to
// production for every build before reading this file, so no build contains
// them; scripts/checkBuild.ts checks every build anyway.
const testOnly =
  process.env.JOBKIT_ENV === "test" && process.env.NODE_ENV !== "production" && !process.env.VERCEL
    ? ["testonly.ts", "testonly.tsx"]
    : [];

const nextConfig: NextConfig = {
  pageExtensions: ["tsx", "ts", "jsx", "js", ...testOnly],
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
