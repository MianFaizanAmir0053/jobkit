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
4. Step 10 once the first deploy is live, then the checks in step 11.
5. Step 12 any time after step 5; the duplicate check uses the list from then on.
6. Step 13 once Claude has drafted the profile; its production half needs step 5.

## 1. Gmail export for the evaluation

In Google Takeout, select only Mail, with only the "Sent" label, format mbox. When the export is ready, save the file under `private/takeout/` in the jobkit folder, then run `npm run eval:import -- --mbox private/takeout/<file>.mbox`. It makes one folder per sent application with `resume.pdf` attached under `private/archive/`, leaves out any whose text holds one of your style examples, and says what it skipped. It also leaves out mail sent after this first import, which jobkit may have drafted; if you have already applied through jobkit by then, add `--jobkit-from <the day you first did, YYYY-MM-DD>`. Running it again adds only new applications. Messages you download by hand in Gmail ("Download message") go in one folder, imported with `npm run eval:import -- --eml <folder>`.

Then copy the phone's screenshots into `private/archive/_screenshots/` and, with the dev server running (`JOBKIT_LOCAL_EVALS=1` in `.env.local`), open http://localhost:3000/dev/label: each case shows the email you sent and the screenshots taken in the three days before it, with a button to add one to the case. Delete the folders of anything that is not an application, and of any resend the page flags. When the cases you mean to keep have their screenshots, run `npm run eval:split` to choose the ten test cases, and label those first; they show no suggestions until their labels are saved. Run `npm run eval:split` again whenever more cases are ready.

## 2. Vercel project

1. Create a private GitHub repository named `jobkit`, empty (no README, no licence), and tell Claude its URL; Claude adds the remote and pushes after you approve the push.
2. In Vercel, import the repository; framework Next.js; function region Singapore. Note the production address (`https://<name>.vercel.app`): it is `<your-vercel-domain>` below.

## 3. Generated secrets

In your own terminal, run this once each for `CRON_SECRET` and `KEEPALIVE_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Both go into Vercel and into `.env.ops.local` (the commit guard reads them there so it can block them). `KEEPALIVE_SECRET` also becomes a GitHub repository secret: on the free plan, private repositories get no environment secrets, and only the keep-alive workflow uses it; it can do nothing but touch the database heartbeat. If your plan offers environments, put it in one restricted to `main` instead. No other secret goes to GitHub. The keep-alive workflow also needs the address it calls: add a repository **variable** (Settings, Secrets and variables, Actions, Variables), not a secret, named `APP_ORIGIN`, with the value `https://<your-vercel-domain>`. If the repository is ever made public, GitHub disables scheduled workflows after 60 days without activity; re-enable the keep-alive schedule then.

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
4. Claude then runs the bootstrap with `--prod`, then the migrations with `--prod`; you type the project reference each time it asks. The bootstrap creates the `jobkit_app` role, the `jobkit` schema and the private storage bucket `jobkit-private`; the migrations create the tables, as `jobkit_app`. After that, Claude runs the live contract tests (`npm run test:live`) against a throwaway schema, which settle whether `pg` works through the transaction pooler.
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

## 11. Checks after the first deploy

1. On the laptop, open `https://<your-vercel-domain>`, sign in with Google, open Devices and pair the phone (Pair a phone, scan the code with the phone's camera, type the phone's six digits on the laptop).
2. Both scheduled endpoints refuse a request without their secret. In your own terminal:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<your-vercel-domain>/api/cron/daily
   ```

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<your-vercel-domain>/api/cron/keepalive
   ```

   Each prints `401`.
3. In GitHub, Actions, keep-alive: run the workflow once by hand (Run workflow). It goes green, which proves the secret and the `APP_ORIGIN` variable.
4. In Vercel, the project's Settings, Cron Jobs lists `/api/cron/daily` at `0 22 * * *`: 22:00 UTC, 03:00 in Pakistan. On the Hobby plan Vercel runs it at some point within that hour.

## 12. Earlier applications

1. Type the applications you made before jobkit into `private/earlier.csv`, one per line: `company,role,applied_on,route,address`. The date is written like `2026-05-04`; the route is `email`, `form` or `message`; the address (an email address or a phone number) may be left out. A header line with those names is fine, and a field that holds a comma goes in double quotes.
2. With `npm run dev` stopped (the local database serves one program at a time, and the script stops if the dev server holds it), check the file against it: `npm run ledger:import private/earlier.csv`. A bad row is reported by its line, and nothing is imported until every row is right.
3. Then import it into production: `npm run ledger:import -- private/earlier.csv --prod`, typing the project reference when asked. Running it again adds nothing new, so a longer list can be imported later, and a row whose company, role and date are unchanged is corrected in place. If you fixed a company or role name, run it with `--replace` as well (`npm run ledger:import -- private/earlier.csv --replace --prod`), which removes the stored rows the file no longer has, so the old spelling does not stay behind.

## 13. Profile

1. Claude drafts `private/profile.yaml` from your CV and portfolio, with every fact set to `approved: false` (profile spec, "Drafting the first version"). Read each fact; edit it or delete it, and set `approved: true` on the ones you stand behind. Then write the gap templates, the known gap lines, the fixed answers and the signature. The CV PDF and 3 to 5 style examples (messages you wrote yourself, as `.txt` files saved as UTF-8) go next to the file, under `private/`, named in it relative to it.
2. With `npm run dev` stopped (the local database serves one program at a time, and the script stops if the dev server holds it), check it against the local database: `npm run profile:seed`. Every problem is reported with its line, and nothing is seeded until the file is right. Start `npm run dev` again to see it on the Profile page.
3. Seed production: `npm run profile:seed -- --prod`, typing the project reference when asked.

To change anything later, edit the file and run steps 2 and 3 again. To roll back, list the stored versions with `npm run profile:seed -- --list --prod`, then make one active again with `npm run profile:seed -- --activate <the start of its hash> --prod`. Seeding an earlier copy of the file, with the same CV and style examples, does the same.
