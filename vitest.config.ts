import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `vitest run --mode live` runs only the live contract tests, which talk to
// real services and spend money; every other run excludes them.
export default defineConfig(({ mode }) => {
  const live = mode === "live";
  return {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      environment: "node",
      include: live
        ? ["src/**/*.live.test.ts", "scripts/**/*.live.test.ts"]
        : ["src/**/*.test.ts", "scripts/**/*.test.ts", "evals/**/*.test.ts"],
      exclude: live ? ["node_modules/**"] : ["**/*.live.test.ts", "node_modules/**", "e2e/**"],
      // Integration tests boot a WebAssembly Postgres (PGlite) or make git
      // repositories, which takes well over the 10-second default once files
      // run in parallel under coverage. Hooks need the same allowance as tests.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      coverage: {
        provider: "v8",
        // The domain logic carries the coverage bar (platform spec A7).
        include: ["src/core/**/*.ts"],
        exclude: ["src/core/**/*.test.ts"],
        thresholds: { lines: 90, branches: 90 },
      },
    },
  };
});
