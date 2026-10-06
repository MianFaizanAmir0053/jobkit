# Runbook: one-time setup

You do every step here in your own browser and terminal. No credential goes in chat or in the repository. Values live in exactly three places (platform spec B8):

- **Vercel**: everything production needs.
- **`.env.local`** on the laptop: development and evaluation values only. The dev server refuses to start if it finds a production database URL or a production model key here.
- **`.env.ops.local`** on the laptop: what the bootstrap, migrate, seed and import scripts need to reach production.

Steps 1, 4 and 9 can start on day 1, before any code exists.

## 1. Gmail export for the evaluation (start first: it can take hours or days)

In Google Takeout, select only Mail, with only the "Sent" label, format mbox. When the export is ready, save the file under `private/takeout/` in the jobkit folder.

## 2. GitHub

1. Create a private repository named `jobkit`, empty (no README, no licence).
2. Tell Claude the repository URL; Claude adds the remote and pushes after you approve the push.
3. Later, add one repository secret, `KEEPALIVE_SECRET` (step 7). On the free plan, private repositories get no environment secrets, so this secret is readable by the repository's workflows; only the keep-alive workflow uses it, and it can do nothing but touch the heartbeat. If your plan offers environments, put it in one restricted to `main` instead. No other secret goes to GitHub.

## 3. Google sign-in client

1. In Google Cloud Console, create a project named `jobkit`. Do not reuse mailagent's projects.
2. Open Google Auth Platform:
   - **Branding:** app name `jobkit`, your support email.
   - **Audience:** user type External, then publish the app ("In production"). With only `openid` and `email` it needs no verification.
   - **Data access:** no scopes beyond `openid` and `email` (Gmail comes in milestone 2).
   - **Clients:** create an OAuth client of type Web application.
     - Authorised JavaScript origins: `http://localhost:3000` and `https://<your-vercel-domain>`.
     - Authorised redirect URIs: `http://localhost:3000/api/auth/google/callback` and `https://<your-vercel-domain>/api/auth/google/callback`.
3. The client ID and secret go into Vercel and `.env.local` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 4. Supabase

1. Create a new free project `jobkit` in the Singapore region. If Supabase says you have no free slot, pause or delete another free project you no longer need, or tell Claude to switch to Neon (ADR 0001, amendment A6). Never put jobkit in mailagent's project.
2. Into `.env.ops.local` only: the direct `postgres` connection string as `DATABASE_BOOTSTRAP_URL`, and a long random password of your choosing as `JOBKIT_APP_DB_PASSWORD`.
3. Into Vercel and `.env.ops.local`: the project URL as `SUPABASE_URL`, and a secret API key in the newer `sb_secret_…` format (not the legacy `service_role` key) as `SUPABASE_SECRET_KEY`.
4. Leave the Data API's exposed schemas at their default (`public` only).
5. After Claude's bootstrap script has created the `jobkit_app` role, the transaction pooler connection string for that role goes into Vercel and `.env.ops.local` as `DATABASE_URL`.

## 5. Anthropic

1. In the Claude Console, create a workspace `jobkit` with a monthly spend limit of $30, and an API key in it: `ANTHROPIC_API_KEY`, in Vercel only.
2. Create a second workspace `jobkit-evals` with a $15 limit, and a key in it: `ANTHROPIC_EVALS_API_KEY`, in `.env.local` only.

## 6. Gemini

In the paid Google AI project mailagent uses, create two new API keys: `jobkit` as `GEMINI_API_KEY` (Vercel only) and `jobkit-evals` as `GEMINI_EVALS_API_KEY` (`.env.local` only). Paid tier only.

## 7. Generated secrets

In your own terminal, run this once each for `CRON_SECRET` and `KEEPALIVE_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`CRON_SECRET` goes into Vercel only; `KEEPALIVE_SECRET` into Vercel and the GitHub repository secret.

## 8. Vercel

1. Import the GitHub repository; framework Next.js; function region Singapore.
2. Environment variables: `OWNER_EMAIL=faizanamir0053@gmail.com`, `APP_ORIGIN=https://<your-vercel-domain>`, `JOBKIT_ENV=production`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CRON_SECRET` and `KEEPALIVE_SECRET`. Never the bootstrap URL, the role password or the evaluation keys.

## 9. Gmail signature

In the Gmail app on the phone (Settings, your account, Mobile signature), set the signature to the same text as the profile's `signature`. jobkit's email kits carry none, so the Gmail app's is the only one.

## 10. Phone

1. Once the first deploy is live, open `https://<your-vercel-domain>` in Chrome on the phone and install it from Chrome's menu ("Install app").
2. Note Chrome's version (Settings, About Chrome) for the share-target spike.
