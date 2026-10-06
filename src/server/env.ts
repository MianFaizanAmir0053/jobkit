/**
 * Where each environment variable lives (platform spec B8).
 *
 * Production values live only in Vercel. The laptop's `.env.local`, which
 * `next dev` loads, holds development and evaluation values and never a
 * production database URL or model key, so a local run cannot spend the
 * app's budget unseen. `.env.ops.local` holds what the bootstrap, migrate,
 * seed and import scripts need, and only those scripts read it, only with
 * `--prod`.
 */
export const ENV_GROUPS = {
  vercel: [
    "OWNER_EMAIL",
    "APP_ORIGIN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "CRON_SECRET",
    "KEEPALIVE_SECRET",
    "JOBKIT_ENV",
  ],
  local: [
    "OWNER_EMAIL",
    "APP_ORIGIN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "JOBKIT_ENV",
    "JOBKIT_LOCAL_EVALS",
    "ANTHROPIC_EVALS_API_KEY",
    "GEMINI_EVALS_API_KEY",
  ],
  ops: [
    "DATABASE_BOOTSTRAP_URL",
    "JOBKIT_APP_DB_PASSWORD",
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "CRON_SECRET",
    "KEEPALIVE_SECRET",
  ],
} as const;

export type EnvName = (typeof ENV_GROUPS)[keyof typeof ENV_GROUPS][number];
