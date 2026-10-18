# Spec: platform

- **Module id:** `platform` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** nothing
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 1, 2, 4, 5, 14, 19, 23, 24, 26 and 29, with amendments A1 to A3, A6, A7, A9 and A11
- **Status:** approved by the owner on 2026-10-06, after two review cycles

Part A sets the conventions every module follows. Part B specifies the platform module itself.

---

## Part A: Project-wide conventions

### A1. Objective of jobkit

jobkit turns a job post the owner shares from their Android phone into an application kit: a structured job record, an eligibility check, a per-requirement fit table, and an email, form or message draft in which every claim cites a fact the owner approved. The owner reviews the kit and sends it through the Gmail app, WhatsApp or the application form. The tool serves one owner and doubles as a portfolio case study, so every stage records its time and cost. Success targets are in ADR 0001 entry 7 and amendment A8. Sending in one click from the owner's Gmail came into the MVP with amendment A20 (SPEC-send.md); the rest of milestone 2's send waits (amendment A1).

### A2. Tech stack

Major versions are pinned when the project is scaffolded; exact versions live in `package-lock.json`.

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 (24.19 installed), npm 11 |
| Web | Next.js 16 (App Router), React 19, TypeScript 5 in strict mode |
| UI | Tailwind CSS v4, shadcn/ui, dark theme with the portfolio's lime `#c8ff3d` as accent on `#060607` |
| Sign-in | `arctic` for Google's OAuth flow; sessions in a jobkit table (B2) |
| Database | Postgres: Supabase Free in production through `pg`; PGlite (`@electric-sql/pglite`) in tests and local development |
| Files | Supabase Storage through `@supabase/supabase-js`, server side only; the local file system in tests and development |
| Models | `@google/genai` with structured outputs through `responseJsonSchema`, for every model stage (decisions A18); `@anthropic-ai/sdk` with `zodOutputFormat`, kept for a stage run on Claude |
| Validation | `zod` for every external input and every model output |
| Tests | Vitest (unit and integration), Playwright with axe (end-to-end tests of jobkit itself only) |
| Tooling | ESLint (Next config), Prettier, `tsx` for scripts |
| Small helpers approved with this spec | `qrcode` (QR rendering), `yaml` (profile file), `sharp` (crops and tiles), `tldts` (registrable domain from the public suffix list) |

Any other runtime dependency needs the owner's approval first. Approved since: `postal-mime` (exact 3.0.1, a dev dependency), which the evaluation import uses to read sent mail; it never ships in the app (the owner's approval, 2026-10-13).

### A3. Architecture rule: ports and adapters

- Domain logic lives in `src/core/<module id>/` as plain TypeScript. It imports no framework, network or file-system code.
- Side effects go through ports declared in `src/core/ports.ts`: `Db`, `Storage`, `Llm`, `Dns`, `Clock` and `Random`.
- Adapters live in `src/adapters/`. Production uses `pg`, Supabase Storage, Gemini (and Anthropic for a stage run on Claude), and `node:dns`. Tests and development use PGlite, the local file system, and fakes for the rest.
- Routes, pages and server actions in `src/app/` stay thin: parse input with zod, check the session (B2), call core, render.
- A composition root (`src/server/container.ts`) wires adapters to ports from environment variables.

### A4. Commands

```bash
npm run dev            # Next dev server: PGlite file database, local storage, fake or real models by env
npm run build          # next build
npm run start          # next start
npm test               # vitest run: unit and integration tests, no network, no model calls
npm run test:watch     # vitest in watch mode
npm run test:e2e       # playwright test against the dev server with fake adapters
npm run lint           # eslint .
npm run typecheck      # tsc --noEmit
npm run format         # prettier --write .
npm run check          # lint, typecheck and test; run before every commit
npm run db:bootstrap   # once, from the laptop: create the jobkit_app role and schema (B1)
npm run db:migrate     # apply db/migrations/*.sql to DATABASE_URL, or to PGlite in development
npm run profile:seed   # validate private/profile.yaml and load it as a new profile version
npm run eval -- --stage extract --model gemini-3.8-flash  # live model calls; costs money; owner-approved runs only
```

### A5. Project structure

```
src/app/                 Next.js pages, route handlers and server actions
src/core/<module id>/    domain logic per module, with colocated *.test.ts files
src/core/ports.ts        port interfaces
src/adapters/            pg, pglite, supabase-storage, local-storage, anthropic, gemini, fake-llm, dns
src/server/              composition root and session helpers
src/lib/                 small shared helpers: ids, hashing, time, encoding
db/migrations/           numbered SQL migrations, forward-only
scripts/                 migrate, profile seed, eval runner, archive import (run with tsx)
evals/                   evaluation harness and public synthetic cases
e2e/                     Playwright tests
private/                 gitignored: profile.yaml, cv.pdf, archive, labels, eval outputs
docs/                    brief, ideas, decisions, runbook
```

### A6. Code style

```ts
// src/core/ledger/duplicates.ts
import type { ApplicationKeys } from "./types";

export type DuplicateReason = "company-role" | "address" | "drafted";
export type DuplicateMatch = { applicationId: string; appliedOn: string; reason: DuplicateReason };

/**
 * Finds earlier applications this one would repeat. Reposts carry new text
 * but the same company and role, so that hash decides; a shared inbox alone
 * only informs, because one address often serves every role.
 */
export function findDuplicates(
  candidate: ApplicationKeys,
  earlier: readonly ApplicationKeys[],
): DuplicateMatch[] {
  return earlier.flatMap((e): DuplicateMatch[] => {
    const reason = matchReason(candidate, e);
    return reason ? [{ applicationId: e.id, appliedOn: e.appliedOn, reason }] : [];
  });
}
```

- Named exports, plain functions and types; classes only where a library needs them.
- Expected failures return values (`{ ok: false, reason }`); exceptions are for bugs and outages.
- File names camelCase, React components PascalCase, database identifiers snake_case, environment variables UPPER_SNAKE_CASE.
- Comments say why, not what. British spelling in user-facing text and documents.
- Commits follow Conventional Commits with the module id as scope, for example `feat(intake): accept several screenshots per share`. One task per commit, ending with the attribution line.

### A7. Testing strategy

- **Test-driven:** every task starts with a failing test (red, green, refactor).
- **Unit tests** sit beside the code in `src/core/**` and do no input or output.
- **Integration tests** (`*.int.test.ts`) drive route handlers and server actions against PGlite, local storage and fake adapters.
- **End-to-end tests** (Playwright, `e2e/`) cover pairing and approval, upload to kit with the fake models, review and handoff, and an accessibility check with axe.
- **No test calls** a real model, DNS or Supabase. Adapter contract tests are named `*.live.test.ts` and run only by hand, through `npm run test:live` (Vitest's `--mode live`), or one file at a time with `npx vitest run --mode live <file>`.
- **Coverage:** `src/core/**` at least 90% of lines and branches, enforced in CI.
- **Fixtures:** synthetic posts, screenshots and recorded model outputs live in `evals/synthetic/` and are public. Real data lives only in `private/`.
- **Evaluations** (live model calls) are separate from tests and run only through `npm run eval`, after the owner approves the spend.

### A8. Boundaries

- **Always:**
  - write the failing test first;
  - run `npm run check` before each commit;
  - parse every external input and every model output with zod;
  - treat job-post text as data, never as instructions;
  - record time and cost for every model call;
  - keep personal data in `private/` or the production database, never in git;
  - follow the module's spec, and update the spec first when a rule has to change.
- **Ask first:**
  - adding a dependency not listed in A2;
  - changing the database schema beyond the specs;
  - changing CI;
  - running live evaluations or anything else that spends money;
  - starting any part of milestone 2 (`SPEC-send.md`);
  - publishing anything.
- **Never:**
  - commit secrets, tokens or personal data, or put credentials in chat;
  - call a real model in a unit or integration test;
  - give tools to a model whose input contains job-post text;
  - send email from jobkit in the MVP;
  - automate LinkedIn or WhatsApp;
  - delete or skip a failing test, or lower a threshold, to get to green.


---

## Part B: The platform module

### B1. Database and migrations

- Migrations are SQL files `db/migrations/NNNN_<name>.sql`, forward-only, applied in order and recorded in `<schema>.schema_migrations`. The same files run on PGlite and on Supabase Postgres.
- Every statement names its schema through the placeholder `{{schema}}` (`{{schema}}.jobs`, never `jobs`), which the migration runner and the `Db` adapters fill in: `jobkit` in production and in tests, a throwaway name in the live contract test. Nothing depends on `search_path`, which Supabase's transaction pooler does not keep between statements.
- The `Db` port offers `query(sql, params)` and `tx(fn)`. The production adapter uses a `pg` pool against Supabase's transaction pooler, with no named prepared statements.
- **Bootstrap (once, from the laptop):** `npm run db:bootstrap` connects with `DATABASE_BOOTSTRAP_URL` (the project's `postgres` role, kept only in the laptop's `.env.ops.local`, see B8) and creates the role `jobkit_app` with the password from `JOBKIT_APP_DB_PASSWORD`, and the schema `jobkit` owned by that role. The password never appears in a migration or in git. Tests run the PGlite equivalent (create the schema) before migrating.
- **Migrations run as `jobkit_app`**, so it owns every jobkit table. Every table has row-level security enabled with no policies: Supabase's `anon` and `authenticated` roles have no grants on the schema and read nothing even if the Data API were exposed, while the owning role is unaffected. The Data API's exposed schemas stay at the default (`public` only).
- **Atomic claims:** every check-then-act on shared rows (redeeming a pairing token, approving a session, claiming a job's lease) is one conditional `UPDATE … WHERE … RETURNING`, never a read followed by a write, because PGlite's single connection would hide a race in tests.
- A live contract test (`--mode live`, by hand) uses the bootstrap connection to create a throwaway schema owned by `jobkit_app`, runs the migrations into it as `jobkit_app`, checks that `jobkit_app` can read and write, that `anon` cannot, and that two concurrent claims on one row let exactly one win, then drops the schema.
- Platform owns these tables: `owner`, `sessions`, `pairing_tokens`, `pending_pairings` (a redeemed phone waiting for its code: the approving session, the code's hash and the tries spent), `jobs` (state, pending stage and lease columns), `job_state_changes`, `job_leases` (each claim of a job's lease, the lease history the times read), `job_stage_runs`, `model_calls`, `heartbeat` and `schema_migrations`. Other modules add theirs in their own migrations.

### B2. Owner sign-in and sessions

- **Google sign-in** uses `arctic` with the authorization-code flow, PKCE and a `state` value held in a short-lived HttpOnly cookie, through two routes: `/api/auth/google/start` and `/api/auth/google/callback`. It asks for `openid` and `email` only. The callback exchanges the code over TLS and reads the ID token's `sub`, `email` and `email_verified` claims.
- **Owner pinning:** the first successful sign-in needs a verified email equal to `OWNER_EMAIL` and stores Google's `sub` in the single-row `owner` table. Every later sign-in must present that same `sub` and a verified email equal to `OWNER_EMAIL`. An empty `OWNER_EMAIL` admits nobody.
- **Session kinds follow the way the session was made:** `google` (a Google sign-in, on any device) or `paired` (a QR pairing). Only `google` sessions can pair, approve and revoke.
- **Sessions:** a session is a `sessions` row plus the cookie `jobkit_session` holding a random 32-byte token (base64url), HttpOnly, Secure, SameSite=Lax, Path=/, with `Max-Age` equal to the session's remaining life. The row stores the token's SHA-256 hash, never the token. Columns: kind, label (from the user agent, for example "Windows · Chrome"), `created_at`, `last_seen_at`, `expires_at`, `approved_at`, and `google_auth_at`.
- **Lifetimes are absolute, never sliding:** a `google` session ends 30 days after it was created, a `paired` session 180 days after (ADR 0001, default for the phone). The cookie is set only when the session is created or rotated, which happens in route handlers and server actions, never while rendering a page.
- **Re-authentication** (the 5-minute rule below) runs Google sign-in from inside a `google` session: on success it updates that same row's `google_auth_at` and rotates the token (new token, new hash, same row).
- **`requireSession({ kind, googleAuthWithin })`** lives in a data access layer (`src/server/dal.ts`): every function that reads or writes the owner's data calls it first, memoised once per request with React's `cache`, and every server action and page calls it too. Route handlers call its request-based twin (`sessionForRead`, or `sessionForChange`, which checks the Origin first, in `src/server/http.ts`): the same lookup and the same requirement check, answering 401 or 403 instead of redirecting. Nothing relies on a layout, because Next 16's own guide says layouts do not re-render on navigation and do not stop child segments from rendering (`docs/runbook/next16-notes.md`). So no server component renders the owner's data for an unapproved, expired or revoked session. It hashes the cookie's token, loads the row, rejects a missing, expired or unapproved session, optionally requires a kind or a recent Google sign-in, and updates `last_seen_at` at most once an hour. An unapproved `paired` session sees only the "Type this code on your laptop" screen.
- **Cross-site requests:** route handlers that change state accept only requests whose `Origin` equals `APP_ORIGIN`; server actions rely on Next's own origin check as well.
- **Sign out** deletes the row. **Revoke** on the Devices page deletes another session's row.
- The proxy (`src/proxy.ts`) only redirects page requests that carry no session cookie to `/login`. The real check is `requireSession`, because Next documents that the proxy can be skipped.
- Exempt from the session check: `/login`, the Google start and callback routes, the `/pair` page shell, `/api/pair/redeem`, `/api/pair/status`, the manifest, icons, the service worker, and the two cron endpoints (B6), which check their own secrets.
- **Test sign-in:** end-to-end tests need a fake Google sign-in. Its route, like every test-only route, exists only in the dev server the end-to-end tests start with `JOBKIT_ENV=test`, and answers only with the in-memory test database. No build contains it, whatever `JOBKIT_ENV` says, and `npm run build` fails any build that does. On Vercel, any `JOBKIT_ENV` other than `production` stops the app at its first request instead of running it with a test or development setup.

### B3. QR pairing

1. On the Devices page, a `google` session taps "Pair a phone". If its last Google sign-in is more than 5 minutes old, it passes through Google sign-in again first, with the account chooser shown. Google offers no way to force a password prompt, so this guards against a stolen cookie used elsewhere, not against someone at the owner's own laptop.
2. The server creates a token of 32 random bytes, stores its SHA-256 hash with `expires_at` two minutes ahead and the creating session's ID, and returns it once. The page renders a QR code for `https://<APP_ORIGIN>/pair#t=<token>` with a countdown and offers a fresh code when it expires.
3. The phone's camera opens the link. The page reads the fragment, removes it at once with `history.replaceState`, and posts the token in the request body to `/api/pair/redeem`.
4. One conditional update marks the token used only if it exists, has not expired, has not been used, and its creating session still exists. The same transaction creates a `paired` session with `approved_at` empty, plus a 6-digit confirmation code stored as a hash, and sets the phone's cookie. The phone shows the code in large digits: "Type this code on your laptop."
5. The creating session's Devices page shows "A phone is waiting. Type the code it shows." Only that session can approve, and only while its Google sign-in is still within 5 minutes. A matching code sets `approved_at`; five wrong codes, Reject, or 5 minutes without approval delete the pending session.
6. Once approved, the phone moves on to the jobs list.

Rules:

- Every redemption failure returns the same message, "This code has expired. Make a new one on your laptop." No failure reveals which check failed.
- Tokens never appear in a URL query string or in server logs. Brute force needs no rate limit: a token carries 256 bits and lives two minutes; the confirmation code allows five tries.
- `paired` sessions cannot create pairing tokens, approve devices or revoke sessions.
- A new code cancels the session's earlier unused ones, so a QR code caught in an older screenshot stops working as soon as the owner makes another.
- Each try at the confirmation code, right or wrong, spends one of the five in a single conditional update, so tries sent at the same moment cannot share a count.
- If more than one phone is waiting, the Devices page lists each with its own code box and says how many are waiting, so a second phone that redeemed a leaked QR code is visible.
- The pairing page removes the token from the address bar with an inline script, while the page is still loading, and keeps it in memory only. The browser's history may still have recorded the link; single use and two minutes bound that.
- A QR code caught in a screenshot or a demo video is useless after two minutes or its first use. Someone who redeems it first still needs the code that only their own screen shows to be typed on the owner's laptop, so the owner, holding their own phone, sees the mismatch.

### B4. Model-call wrapper

- `callModel({ stage, jobId, model, system, content, schema, effort, maxTokens })` returns the parsed output and its usage, or a typed failure. The provider follows from the model ID.
  - **Claude:** a streamed request with `output_config.format` set from the stage's zod schema and `output_config.effort`; the final message is parsed with the same schema. The format keeps the schema's `enum` and `const` values as constraints wherever the SDK's zod helper keeps the schema's structure (objects' properties, arrays' items, unions and shared definitions): the helper folds them into descriptions, and the adapter puts them back. Stage schemas use no records or tuples, which structured outputs do not support. Structured outputs do not guarantee the case of enum and const values, so a stage schema writes its enum fields with `caseless`, and no two values of one field differ only in case. A stage schema describes the answer as the model writes it: nothing in it changes a value (no transform, preprocess, default, catch, trim or change of case) except `caseless`. zod refuses a discriminated union whose discriminator is `caseless`, so a field that chooses between branches makes them a plain union. Server-side refusal fallbacks are enabled in their default form if the API accepts them together with structured outputs; the implementation checks the current documentation first.
  - **Gemini:** a JSON-schema response format, then the same zod parse. The model ID is pinned at implementation after checking Google's current model list, and only the paid tier is used (ADR 0001 entry 2).
- The wrapper has no parameter for tools, so no stage can hand a tool to a model that reads post text.
- **Logging, one row per request attempt:** before each attempt the wrapper inserts a `model_calls` row with outcome `started`, then completes it: the model that actually answered (`response.model`), input, output (thinking included), cache-read and cache-write tokens per iteration, cost in US dollars, end time, outcome, and the provider's request ID. A retried request has two rows. An attempt that ends without usage (timeout, dropped connection, a row left `started` by a killed invocation and marked `abandoned` when the job is next claimed) records a provisional cost: its input tokens, counted before sending, at the input rate, plus its `max_tokens` at the output rate. Provisional costs count towards the cap and are labelled as upper bounds on the Spend page. A reply that arrives without usage keeps its provisional cost too. The bound covers one run of the requested model: with refusal fallbacks on, an attempt that falls back and then breaks off can have cost more, by at most its fallback run.
- **Costs** come from a price table in code, checked against the providers' pricing pages whenever the table changes: Claude Opus 5.5 at $4 per million input tokens and $20 per million output tokens, Claude Sonnet 5.5 at $2 and $10, any model a refusal fallback can route to at its own rates, cache reads and writes at their published rates, and Gemini 3.8 and 3.6 Flash, Gemini 3.1 Pro and Gemini 2.5 Pro at Google's published rates. Both providers bill thinking tokens as output. Each fallback iteration is priced at the rates of the model that ran it. An unknown model ID gets the provisional cost above and a warning on the Spend page.
- **Guard:** before each attempt the wrapper runs a guard injected by the composition root. In the app, the ledger supplies it to enforce the monthly cap. When the guard refuses, no request is sent and the outcome is `refused-cap`.
- **Timeouts and retries:** the SDKs' own retries are switched off (`maxRetries: 0`). Responses are streamed: an attempt is abandoned when no event arrives for 45 seconds, or when it passes 200 seconds in all. Anything the provider sends counts, keep-alive pings included, and Gemini is asked to stream its thought summaries, since a model that thinks silently would otherwise look stalled. The wrapper retries once on a rate limit, a server error or a dropped connection, after the `retry-after` the provider sends, capped at 15 seconds; it never retries a timeout, a refusal or any other client error. A model stage's worst case is therefore about 225 seconds (up to 10 to count the input, then 200 for its attempts and 15 for one retry's wait) plus its own image and database work.
- **Refusal:** a `refusal` stop reason fails the stage at once, with no retry and the message "The model declined this post."
- **Caching** is decided per stage in the module specs. In the MVP no stage uses prompt caching (drafting spec explains why); the stable parts of each prompt still come first, so caching can be switched on without reordering.
- **Evaluations** use the same wrapper with their own composition: a local PGlite database seeded from `private/profile.yaml`, the evaluation key of the model a run uses (`GEMINI_EVALS_API_KEY`, or `ANTHROPIC_EVALS_API_KEY` for a run on Claude), and a guard enforcing the run's `--budget`. They refuse to start with any remote database URL or with the app's keys, so evaluation spend never reaches the app's `model_calls`, its cap or its workspace.

### B5. App shell and PWA

- Mobile-first layout with 16-pixel side gutters, dark theme, lime accent.
- Navigation: Jobs, New job, Stats and Spend for every session; Profile (a read-only view of approved facts and the fixed answers) and Devices for `google` sessions only, so salary, work-authorisation and equal-opportunity answers stay off paired phones.
- The web app manifest has the name "jobkit", 192- and 512-pixel icons, `start_url` `/jobs`, `display: standalone`, and the `share_target` defined in the intake spec. It is served outside the session check.
- A minimal service worker exists because installability and the share target need one. It handles the share-target POST (intake spec) and caches nothing that holds personal data.

### B6. Keep-alive and the daily jobs

- `GET /api/cron/keepalive` accepts only `Authorization: Bearer <KEEPALIVE_SECRET>`. It runs three small queries and updates the `heartbeat` row, and can do nothing else. A GitHub Actions schedule calls it every 8 hours. On GitHub's free plan, environment secrets are not available to private repositories, so `KEEPALIVE_SECRET` is a repository secret referenced only by the keep-alive workflow; it is the only secret in GitHub and can do nothing but touch the heartbeat. If the owner's plan offers environments, the secret moves into one restricted to `main`.
- `GET /api/cron/daily` accepts only `Authorization: Bearer <CRON_SECRET>`, which only Vercel holds. Vercel's cron calls it once a day. It touches the heartbeat and runs the retention purges that intake and ledger define.
- GitHub disables scheduled workflows in public repositories after 60 days without activity. If the repository goes public, the runbook says to re-enable the schedule; the daily Vercel run alone still makes a few database requests a day.

### B7. CI and the guard

- GitHub Actions on every push and pull request: `npm ci`, lint, typecheck, tests with the coverage threshold, build, and the guard below over the whole tree and over every commit the push adds. The checkout fetches full history; on a new branch, whose `before` is all zeros, "added commits" means those not on `main`. These jobs get no secrets.
- `npm run prepare` sets `core.hooksPath` to `.githooks`. The pre-commit hook runs the same guard on staged changes. It blocks:
  - a path under `private/` or `.data/` (the local database, which holds copies of the profile and CV), a `.env` file other than `.env.example`, or a file larger than 1 MB;
  - content matching a key pattern: Anthropic keys (`sk-ant-`), Google API keys (`AIza`, and the newer `AQ.`), Google OAuth client secrets (`GOCSPX-`), Supabase secret keys (`sb_secret_`), connection strings carrying a password (`postgres://user:password@` and `postgresql://` alike), private-key headers, and long JWT-shaped strings;
  - on the laptop, any staged text containing an exact value of 12 characters or more from `.env.local` or `.env.ops.local`, which catches the random secrets no pattern can.
- Before the repository is made public, a full-history scan runs (ADR 0001 entry 30).

### B8. Environment variables

Three places hold values, each with its own purpose. All are documented in `.env.example` with empty values; the owner sets real values, and none goes in chat or git.

- **Vercel (production only):** `OWNER_EMAIL`, `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL` (as `jobkit_app`, through the transaction pooler), `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Supabase's newer secret key format; the legacy `service_role` key is not used), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GMAIL_TOKEN_KEY` (32 random bytes as base64, sealing the Gmail refresh token one-click send uses; decisions A20), `CRON_SECRET`, `KEEPALIVE_SECRET` and `JOBKIT_ENV=production`.
- **`.env.local` (development and evaluations on the laptop; `next dev` loads it):** `OWNER_EMAIL`, `APP_ORIGIN=http://localhost:3000`, the Google client values, `JOBKIT_ENV=development`, `GEMINI_EVALS_API_KEY` and the laptop's own `GMAIL_TOKEN_KEY`, with `ANTHROPIC_EVALS_API_KEY` only for a stage run on Claude. No production database URL and no production model key: the dev server and the evaluation runner refuse to start if they find a remote `DATABASE_URL`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`, so a local run can never spend the app's budget unseen.
- **`.env.ops.local` (laptop operations only; never loaded by the app):** `DATABASE_BOOTSTRAP_URL` (Supabase's session pooler for the `postgres` role, which works over IPv4), `JOBKIT_APP_DB_PASSWORD`, the production `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and copies of `CRON_SECRET` and `KEEPALIVE_SECRET` so the guard's exact-value check knows them.

**Scripts never reach production by accident.** The bootstrap, migrate, seed and import scripts work on the local PGlite database by default. Only with `--prod` do they load `.env.ops.local`, and then they print the target project and ask the owner to type its reference before changing anything. The bootstrap also creates the private storage bucket `jobkit-private`.

**Vercel previews hold no secrets.** Every variable in Vercel is scoped to the Production environment only, so a preview deployment of a branch has no keys, fails closed, and cannot spend or read anything.


### B9. Jobs, states and the pipeline runner

Modules register stages; the runner owns their order, the job's state and the bookkeeping, not the stages' logic.

**Job states** (`jobs.state`), their kinds and transitions: the single table every other spec cites. Every change of state is recorded in `job_state_changes` with its time.

| State | Kind | Meaning | Next states |
|---|---|---|---|
| `manual_run` | owner | assigned to the manual arm of the timing comparison (ledger spec); nothing uploads and no stage runs | `closed` (Stop) |
| `uploading` | client | intake is receiving images | `queued`, `upload_failed` |
| `upload_failed` | owner | the upload did not complete within 15 minutes, or its objects were missing; or Upload again restarted an upload under way, on its way back to `uploading` | `uploading` (Upload again), `closed` (Skip) |
| `queued` | running | ready for the first stage | `extracting` |
| `extracting` | running | `extract` or `extract_questions` due or running | `needs_role_pick`, `checking`, `drafting` (new form questions on a ready kit), `stopped`, `failed` |
| `needs_role_pick` | waiting | the owner picks a role | `checking`; on Skip, `closed`, or back to `kit_ready` if another role already has a kit |
| `checking` | running | `eligibility` (code only, no model) | `needs_eligibility_decision`, `needs_kit_type`, `drafting`, `failed` |
| `needs_eligibility_decision` | waiting | Draft anyway or Skip | `needs_kit_type`, `drafting`, `closed` |
| `needs_kit_type` | waiting | the route is `other` or `unknown`; the owner picks email, form or message | `drafting`, `closed` |
| `drafting` | running | `templates` first (code only: drafts from the owner's approved templates, decisions A22), then `draft` or `draft_answers`, each with `address_read` and `address_checks` alongside | `kit_ready` (after `templates`, when a template drafted the kit), `drafting` (after `templates`, with `draft`, when none did), `judging` (after `draft` or `draft_answers`), `failed` |
| `judging` | running | `judge` | `kit_ready`, `failed` |
| `kit_ready` | ready | the kit is ready for review | `extracting` (screenshots added), `drafting` (contact edited, another kit type, new questions, or a Gemini draft beside the templates', decisions A22), `needs_role_pick` (another role) |
| `stopped` | owner | not a job post, not in English, or no role found | `extracting` (the owner confirms a post marked "not a job post", or has a post with no role found read again; the confirmation is given once per job, never for language), `closed` |
| `failed` | owner | a stage failed; the page shows the stage, a readable reason, Retry and Skip | the failed stage's running state (Retry), `kit_ready` ("Back to your drafts", only from `draft` or `judge`, when a Gemini draft asked for beside the templates' failed), `closed` (Skip) |
| `closed` | final | finished without a kit, or skipped | none |

- **Kinds:** only `running` jobs are advanced by the runner. `waiting` and `owner` states move only on the owner's action; `client` moves on intake's requests; `ready` and `final` never advance by themselves. The application's outcome (sent, submitted, skipped, bounced) is the ledger's status, not a job state.
- **Pending stage:** a running job records which stage is due next (`jobs.pending_stage`), so `extracting` knows whether `extract` or `extract_questions` comes next, and `drafting` whether it is `templates`, `draft` or `draft_answers`.
- **Timeouts are checked when status is read** (each poll and page load), and again by the daily cron as a backstop: a job still `uploading` 15 minutes after it began uploading (at creation, or at Upload again) moves to `upload_failed`; a pending pairing older than 5 minutes is deleted.

**Stage runs and idempotency:** each stage run is recorded in `job_stage_runs` with the stage, its input hash, its output and output hash, start and end times, and an attempt number. Each stage hashes only what it reads, and a stage whose output already exists for the same input hash reuses it without calling a model:

| Stage | Input hash covers |
|---|---|
| `extract` | post image hashes and pasted text; the owner's "This is a job post" confirmation; model, effort and prompt version |
| `extract_questions` | form image hashes; model, effort and prompt version |
| `eligibility` | the record's output hash; the chosen role; the profile version; the owner's eligibility decision; the role's zone's offset from UTC that day, on which the overlap turns |
| `templates` | the record's output hash; the chosen role; the profile version; the build's version |
| `draft` | the record's output hash; the chosen role; the profile version; the kit type; the owner's declined instructions; model, effort and prompt version |
| `draft_answers` | the IDs and texts of questions not yet answered; the profile version; model, effort and prompt version |
| `address_read` | the contact and its kind, which the output is for; from a screenshot, the crop's hash, by the screenshot's hash, the box and the crop's rules it is made from, with the model, whether this machine has it, effort, the token limit and the prompt version; from pasted text, the text's hash and the matching's version |
| `address_checks` | the address as it now stands (extracted or typed by the owner), the company's name the name check reads, and the checks' version |
| `judge` | the output hash of `draft` or `draft_answers`; the cited facts' hash; model, effort and prompt version |

So the owner's override re-runs `extract`; an edited address re-runs only `address_checks`, and the draft, the verdicts and the owner's edits stay; new screenshots re-run what reads them and nothing else.

**Leases instead of self-requests:**

- The runner advances a `running` job when a request finds it unclaimed: the upload confirmation, or a page that polls. `POST /api/jobs/<id>/advance` is a normal session-checked, origin-checked request.
- `advance` claims the job's lease with one conditional update that succeeds only when no unexpired lease exists, sets the lease to expire 330 seconds later (longer than Vercel's 300-second limit, so a killed invocation's lease always lapses), replies 202, and runs the pipeline in Next's `after()`. `after()` runs within the route's maximum duration, so both routes that start the pipeline export `maxDuration = 300`.
- Within that invocation the runner runs stages in order. It starts a model stage only if 225 seconds (its worst case, B4) still fit before 285 seconds of invocation time, counted from the request's start; otherwise it releases the lease and stops, and the next poll resumes it. A typical job (extract about 25 seconds, the drafting group about 30, the judge about 15) finishes in one invocation.
- No request ever calls the app's own URL, so Vercel's loop detection and deployment protection never come into play.
- A stage started three times without finishing since it last finished (killed invocations or retryable errors) moves the job to `failed`; Retry resets that stage's attempt count. A refusal fails at once.
- **Polling:** the job page polls every 2 seconds only while the job is `running` or `client`, slowing to every 5 seconds after a minute, and stops while the page is hidden. The jobs list polls every 10 seconds only while some job is running. Ready, waiting, owner and final states are never polled. This keeps the app well inside Vercel Hobby's monthly invocations.

**Times** (computed from `job_state_changes`, `job_stage_runs` and the lease history):

- **Machine time** runs from the job's start (intake's clock) to its first `kit_ready`. It excludes every interval spent in a `waiting` or `owner` state, and, of every gap in which the job was runnable but unclaimed because no page was polling (a locked phone, a closed app), all but the first 10 seconds, which a slow poll and its request explain (the page polls every 5 seconds after a minute, and a poll's network time and any cold start come on top). That remainder is reported separately as paused time. Upload, cold starts and normal poll delays count.
- **Processing time** is the union of stage-run intervals, so the drafting group's concurrent stages are counted once.

### B10. Acceptance criteria

1. On a fresh clone, `npm run check` passes with nothing but the `.env.example` defaults: tests use PGlite and fakes.
2. A Google account other than `OWNER_EMAIL`, an unverified email, or a different `sub` after the first sign-in cannot sign in; the owner's sign-in creates a `google` session whose row holds only the token's hash.
3. Session lifetimes are absolute: a `google` session is refused after 30 days and a `paired` one after 180, however often they are used; the cookie's `Max-Age` matches.
4. Re-authentication updates the same row's `google_auth_at` and rotates the token; the old token stops working.
5. A pairing token can be created only by a `google` session whose Google sign-in is at most 5 minutes old. It works exactly once, within two minutes, while its creating session exists; every failure returns the same message.
6. A redeemed `paired` session is refused everywhere until approved, including when it loads `/jobs`, `/stats` or a job page, which render only the waiting screen. Only the creating session can approve, only with the matching confirmation code and a Google sign-in still within 5 minutes; five wrong codes, Reject or 5 minutes without approval delete it.
7. In the end-to-end pairing test, no request URL and no server log line contains the token.
8. After a session is revoked, its next request or page load is refused and redirected to sign-in. `paired` sessions cannot reach the Devices page, create tokens, approve or revoke (server-side checks).
9. A state-changing request with a foreign `Origin` is refused.
10. The test sign-in route returns 404 in a production build.
11. Every request attempt has exactly one `model_calls` row: inserted as `started` before sending and completed after, recording the answering model and each iteration's cost; a retried call has two rows; an attempt without usage carries a provisional upper-bound cost; a call refused by the guard sends nothing; a refusal is not retried; the SDK's own retries are off; a stream silent for 45 seconds is abandoned.
12. The wrapper's type signature has no way to pass tools (a type-level test fails to compile if one is added).
13. Evaluation runs write only to their local database, use only the evaluation keys, and refuse to start when a remote database URL or an app key is present; the dev server refuses the same.
14. The keep-alive endpoint accepts only `KEEPALIVE_SECRET` and only touches the heartbeat; the daily endpoint accepts only `CRON_SECRET`; each rejects the other's secret.
15. CI runs lint, typecheck, tests with the coverage threshold, build and the guard over the tree and the commits the push adds, including on a new branch. The guard blocks a staged file under `private/`, staged strings shaped like each key pattern in B7, a connection string with a password, and an exact value from the local env files.
16. Migrations apply cleanly to an empty PGlite database after the test bootstrap, and running them again changes nothing; every statement uses the `{{schema}}` placeholder.
17. Runner: only `running` jobs advance; stages run in order inside one claimed invocation; a second `advance` while the lease is live is refused; a lapsed lease can be claimed again; each stage's input hash follows its row in the table, so the override re-runs `extract`, an edited address re-runs only `address_checks`, and an unchanged input reuses the output with no model call; three unfinished starts move the job to `failed`, and Retry resumes; Skip closes `failed`, `upload_failed` and `stopped` jobs; timeouts apply when status is read; every transition outside the table is refused.
18. Times: machine time ends at the first `kit_ready`, includes upload and normal poll delays, and excludes waiting and owner states and what unpolled gaps run past 10 seconds, which is reported as paused time; processing time counts concurrent stages once.
19. Polling stops while the page is hidden and never runs for ready, waiting, owner or final states.
