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
  },
});
