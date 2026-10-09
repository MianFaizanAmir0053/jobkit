/**
 * A Vercel deployment, production or preview. Vercel sets VERCEL=1 and
 * VERCEL_ENV at build and run time; `vercel env pull` can write both into a
 * local .env file too, with VERCEL_ENV=development, which is no deployment.
 * https://vercel.com/docs/environment-variables/system-environment-variables
 */
export function onVercelDeployment(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.VERCEL === "1" && (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview");
}
