import { onVercelDeployment } from "@/server/deployEnv";
import { assertLocalOnly, isLocalRun } from "@/server/localOnly";

/**
 * Runs once when a Next.js server starts, before it serves a request. A
 * local server refuses to start with a value only production holds (platform
 * spec B8, AC13), so a local run can never spend the app's budget unseen.
 * Next reports the error and serves nothing. On a Vercel deployment the
 * container's own check names the real fault, a wrong JOBKIT_ENV, instead.
 * The container also checks every local build, since the dev server reloads
 * edited .env files without running this again.
 */
export function register(): void {
  const env = process.env;
  if (env.NEXT_RUNTIME === "nodejs" && isLocalRun(env) && !onVercelDeployment(env)) {
    assertLocalOnly(env, "This local server");
  }
}
