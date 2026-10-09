import { onVercelDeployment } from "@/server/deployEnv";
import { assertLocalOnly, isLocalRun } from "@/server/localOnly";

/**
 * Runs once when a Next.js server starts, before it serves a request. A
 * local server refuses to start with a value only production holds (platform
 * spec B8, AC13), so a local run can never spend the app's budget unseen.
 * Next reports the error and serves nothing. The dev server is always
 * checked: `vercel env pull` can write Vercel's own variables into a local
 * file. Only a production build on a Vercel deployment is left to the
 * container, whose check names the real fault there, a wrong JOBKIT_ENV.
 * The container also checks every local build, since the dev server reloads
 * edited .env files without running this again.
 */
export function register(): void {
  const env = process.env;
  const dev = env.NODE_ENV === "development";
  if (env.NEXT_RUNTIME === "nodejs" && isLocalRun(env) && (dev || !onVercelDeployment(env))) {
    assertLocalOnly(env, "This local server");
  }
}
