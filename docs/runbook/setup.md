# Runbook: one-time setup

You do every step here in your own browser and terminal. No credential goes in chat or in the repository. Values live in exactly three places (platform spec B8):

- **Vercel**: everything production needs, scoped to the Production environment only, so preview deployments hold no secrets.
- **`.env.local`** on the laptop: development and evaluation values only. The dev server refuses to start if it finds a production database URL or a production model key here.
- **`.env.ops.local`** on the laptop: what the bootstrap, migrate, seed and import scripts need to reach production. They use it only when run with `--prod`, and then ask you to type the project reference first.

The repository ignores `private/` and every `.env*` file except `.env.example`, so nothing in them can be committed.

## Order

1. Start the Gmail export (step 1) on day 1; it can take hours or days.
2. Steps 2 to 8 when Claude reaches Task 7 (the deploy skeleton). Step 2 comes before step 4 because the Google client needs the Vercel address.
3. Step 9 after you have approved the profile, so the signature text is final.
4. Step 10 once the first deploy is live.

## 1. Gmail export for the evaluation

In Google Takeout, select only Mail, with only the "Sent" label, format mbox. When the export is ready, save the file under `private/takeout/` in the jobkit folder.

## 2. Vercel project

1. Create a private GitHub repository named `jobkit`, empty (no README, no licence), and tell Claude its URL; Claude adds the remote and pushes after you approve the push.
2. In Vercel, import the repository; framework Next.js; function region Singapore. Note the production address (`https://<name>.vercel.app`): it is `<your-vercel-domain>` below.

## 3. Generated secrets

In your own terminal, run this once each for `CRON_SECRET` and `KEEPALIVE_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Both go into Vercel and into `.env.ops.local` (the commit guard reads them there so it can block them). `KEEPALIVE_SECRET` also becomes a GitHub repository secret: on the free plan, private repositories get no environment secrets, and only the keep-alive workflow uses it; it can do nothing but touch the database heartbeat. If your plan offers environments, put it in one restricted to `main` instead. No other secret goes to GitHub. If the repository is ever made public, GitHub disables scheduled workflows after 60 days without activity; re-enable the keep-alive schedule then.

## 4. Google sign-in client

1. In Google Cloud Console, create a project named `jobkit`. Do not reuse mailagent's projects.
2. Open Google Auth Platform:
   - **Branding:** app name `jobkit`, your support email.
   - **Audience:** user type External, then publish the app ("In production"). With only `openid` and `email` it needs no verification.
   - **Data access:** no scopes beyond `openid` and `email` (Gmail comes in milestone 2).
   - **Clients:** create an OAuth client of type Web application.
     - Authorised JavaScript origins: `http://localhost:3000` and `https://<your-vercel-domain>`.
     - Authorised redirect URIs: `http://localhost:3000/api/auth/google/callback` and `https://<your-vercel-domain>/api/auth/google/callback`.
3. The client ID and secret go into Vercel and `.env.local` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 5. Supabase

1. Create a new free project `jobkit` in the Singapore region. If Supabase says you have no free slot, pause or delete another free project you no longer need, or tell Claude to switch to Neon (ADR 0001, amendment A6). Never put jobkit in mailagent's project.
2. Into `.env.ops.local`:
   - `DATABASE_BOOTSTRAP_URL`: the **session pooler** connection string for the `postgres` user (the direct connection needs IPv6, which many networks lack);
   - `JOBKIT_APP_DB_PASSWORD`: a long random password of your choosing;
   - `SUPABASE_URL`: the project URL;
   - `SUPABASE_SECRET_KEY`: a secret API key in the newer `sb_secret_…` format (not the legacy `service_role` key).
3. Leave the Data API's exposed schemas at their default (`public` only).
4. Claude then runs the bootstrap with `--prod`; you type the project reference when it asks. The bootstrap creates the `jobkit_app` role, the `jobkit` schema and the private storage bucket `jobkit-private`.
5. `DATABASE_URL`: the **transaction pooler** connection string (port 6543) with the user written as `jobkit_app.<project-ref>` and the password from step 2. It goes into Vercel and `.env.ops.local`; never the `postgres` string.
6. `SUPABASE_URL` and `SUPABASE_SECRET_KEY` also go into Vercel.

## 6. Anthropic

1. In the Claude Console, create a workspace `jobkit` with a monthly spend limit of $30, and an API key in it: `ANTHROPIC_API_KEY`, in Vercel only.
2. Create a second workspace `jobkit-evals` with a $15 limit, and a key in it: `ANTHROPIC_EVALS_API_KEY`, in `.env.local` only.

## 7. Gemini

Quotas are counted per Google Cloud project, so the app and the evaluations get separate projects, and neither shares mailagent's quota. In Google AI Studio, create two projects, `jobkit` and `jobkit-evals`, both linked to the billing account mailagent already uses (paid tier; no new card). Create one key in each: `GEMINI_API_KEY` (Vercel only) and `GEMINI_EVALS_API_KEY` (`.env.local` only).

## 8. The rest of `.env.local` and Vercel

- **`.env.local`:** `OWNER_EMAIL=faizanamir0053@gmail.com`, `APP_ORIGIN=http://localhost:3000`, `JOBKIT_ENV=development`, `JOBKIT_LOCAL_EVALS=1`, plus the Google client values and the two evaluation keys above.
- **Vercel (Production only):** `OWNER_EMAIL=faizanamir0053@gmail.com`, `APP_ORIGIN=https://<your-vercel-domain>`, `JOBKIT_ENV=production`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CRON_SECRET` and `KEEPALIVE_SECRET`. Never the bootstrap URL, the role password or the evaluation keys.

## 9. Gmail signature

After the profile is approved: in the Gmail app on the phone (Settings, your account, Mobile signature), set the signature to the same text as the profile's `signature`. jobkit's email kits carry none, so the Gmail app's is the only one.

## 10. Phone

1. Open `https://<your-vercel-domain>` in Chrome on the phone and install it from Chrome's menu ("Install app").
2. Note Chrome's version (Settings, About Chrome) for the share-target spike.
