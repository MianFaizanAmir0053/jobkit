import type { NextConfig } from "next";

// Test-only routes (files named route.testonly.ts or page.testonly.tsx, under
// /api/test/ and /test/) exist only in builds made with JOBKIT_ENV=test, so no
// other build contains them (platform spec B2). scripts/checkBuild.ts checks
// every build for them.
const testOnly = process.env.JOBKIT_ENV === "test" ? ["testonly.ts", "testonly.tsx"] : [];

const nextConfig: NextConfig = {
  pageExtensions: ["tsx", "ts", "jsx", "js", ...testOnly],
};

export default nextConfig;
