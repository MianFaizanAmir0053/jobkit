import type { NextConfig } from "next";

// The test sign-in route (src/app/api/test/signin/route.testonly.ts) is a
// route only in builds made with JOBKIT_ENV=test, so no other build contains
// it (platform spec B2). scripts/checkBuild.ts checks every build for it.
const testOnly = process.env.JOBKIT_ENV === "test" ? ["testonly.ts"] : [];

const nextConfig: NextConfig = {
  pageExtensions: ["tsx", "ts", "jsx", "js", ...testOnly],
};

export default nextConfig;
