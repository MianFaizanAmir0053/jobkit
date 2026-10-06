import { defineConfig } from "@playwright/test";

const PORT = 3300;
const ORIGIN = `http://localhost:${PORT}`;

/**
 * End-to-end tests of jobkit itself (platform spec A7), against the dev
 * server with JOBKIT_ENV=test: an in-memory database and the test sign-in
 * route. They drive the Chrome already installed (a fresh, temporary
 * profile), so no browser download is needed; the owner's phone runs Chrome.
 */
export default defineConfig({
  testDir: "e2e",
  // One dev server and one in-memory database: tests run one at a time.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: { baseURL: ORIGIN, channel: "chrome", trace: "retain-on-failure" },
  webServer: {
    command: "node e2e/devServer.mjs",
    url: `${ORIGIN}/login`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { JOBKIT_ENV: "test", APP_ORIGIN: ORIGIN, PORT: String(PORT) },
  },
});
