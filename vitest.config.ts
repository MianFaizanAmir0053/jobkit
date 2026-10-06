import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "evals/**/*.test.ts"],
    // Live contract tests talk to real services and spend money; they run only by hand.
    exclude: ["**/*.live.test.ts", "node_modules/**", "e2e/**"],
    coverage: {
      provider: "v8",
      // The domain logic carries the coverage bar (platform spec A7).
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/**/*.test.ts"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
