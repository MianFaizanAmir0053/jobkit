import { onVercelDeployment } from "./deployEnv";

/**
 * Whether New job's request says the owner sent it, so a share may start
 * with no tap (intake spec, "Inputs"), from its Fetch Metadata header
 * (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site):
 * "none" is the owner's own doing, such as the share sheet or the address
 * bar. No jobkit page posts a share itself, so "same-origin" counts only in
 * the dev server the end-to-end tests start, which post one from jobkit's
 * own page, locked as the test-only routes are; anything else, or no
 * header, waits for the tap.
 */
export function ownerSent(
  site: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (site === "none") return true;
  const endToEnd =
    env.JOBKIT_ENV === "test" && env.NODE_ENV === "development" && !onVercelDeployment(env);
  return site === "same-origin" && endToEnd;
}
