import { assertLocalOnly, isLocalRun } from "@/server/localOnly";

/**
 * Runs once when a Next.js server starts, before it serves a request. A
 * local server refuses to start with a value only production holds (platform
 * spec B8, AC13), so a local run can never spend the app's budget unseen.
 * Next reports the error and serves nothing. The container checks again on
 * every start, since the dev server reloads edited .env files without
 * running this again.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs" && isLocalRun(process.env)) {
    assertLocalOnly(process.env, "This local server");
  }
}
