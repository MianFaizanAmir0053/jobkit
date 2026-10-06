# Spec: platform

- **Module id:** `platform` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** nothing
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 1, 2, 4, 5, 14, 19, 23, 24, 26 and 29, with amendments A1 to A3, A6, A7, A9 and A11
- **Status:** draft for owner approval

Part A sets the conventions every module follows. Part B specifies the platform module itself.

---

## Part A: Project-wide conventions

### A1. Objective of jobkit

jobkit turns a job post the owner shares from their Android phone into an application kit: a structured job record, an eligibility check, a per-requirement fit table, and an email, form or message draft in which every claim cites a fact the owner approved. The owner reviews the kit and sends it through the Gmail app, WhatsApp or the application form. The tool serves one owner and doubles as a portfolio case study, so every stage records its time and cost. Success targets are in ADR 0001 entry 7 and amendment A8. One-tap sending is milestone 2 (amendment A1).

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
| Models | `@anthropic-ai/sdk` with structured outputs through `zodOutputFormat`; `@google/genai` for the Gemini second read |
| Validation | `zod` for every external input and every model output |
| Tests | Vitest (unit and integration), Playwright with axe (end-to-end tests of jobkit itself only) |
| Tooling | ESLint (Next config), Prettier, `tsx` for scripts |
| Small helpers approved with this spec | `qrcode` (QR rendering), `yaml` (profile file), `sharp` (crops and tiles), `tldts` (registrable domain from the public suffix list) |

Any other runtime dependency needs the owner's approval first.

### A3. Architecture rule: ports and adapters

- Domain logic lives in `src/core/<module id>/` as plain TypeScript. It imports no framework, network or file-system code.
- Side effects go through ports declared in `src/core/ports.ts`: `Db`, `Storage`, `Llm`, `Dns`, `Clock` and `Random`.
- Adapters live in `src/adapters/`. Production uses `pg`, Supabase Storage, Anthropic and Gemini, and `node:dns`. Tests and development use PGlite, the local file system, and fakes for the rest.
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
npm run eval -- --stage extract --model claude-opus-5-5   # live model calls; costs money; owner-approved runs only
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
- **No test calls** a real model, DNS or Supabase. Adapter contract tests run only when `JOBKIT_LIVE=1` is set, by hand.
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

- Migrations are SQL files `db/migrations/NNNN_<name>.sql`, forward-only, applied in order and recorded in `jobkit.schema_migrations`. The same files run on PGlite and on Supabase Postgres.
- Every statement names its schema (`jobkit.jobs`, never `jobs`), so nothing depends on `search_path`, which Supabase's transaction pooler does not keep between statements.
- The `Db` port offers `query(sql, params)` and `tx(fn)`. The production adapter uses a `pg` pool against Supabase's transaction pooler, with no named prepared statements.
- **Bootstrap (once, from the laptop):** `npm run db:bootstrap` connects with `DATABASE_BOOTSTRAP_URL` (the project's `postgres` role, kept only in the laptop's `.env.local`) and creates the role `jobkit_app` with the password from `JOBKIT_APP_DB_PASSWORD`, and the schema `jobkit` owned by that role. The password never appears in a migration or in git.
- **Migrations run as `jobkit_app`**, so it owns every jobkit table. Every table has row-level security enabled with no policies: Supabase's `anon` and `authenticated` roles have no grants on the schema and read nothing even if the Data API were exposed, while the owning role is unaffected. The Data API's exposed schemas stay at the default (`public` only).
- **Atomic claims:** every check-then-act on shared rows (redeeming a pairing token, approving a session, claiming a job's lease) is one conditional `UPDATE … WHERE … RETURNING`, never a read followed by a write, because PGlite's single connection would hide a race in tests.
- A live contract test (`JOBKIT_LIVE=1`, by hand) runs migrations into a throwaway schema on the real database, checks that `jobkit_app` can read and write, that `anon` cannot, and that two concurrent claims on one row let exactly one win, then drops the schema.
- Platform owns these tables: `owner`, `sessions`, `pairing_tokens`, `jobs` (state and lease columns), `job_stage_runs`, `model_calls`, `heartbeat` and `schema_migrations`. Other modules add theirs in their own migrations.

### B2. Owner sign-in and sessions

- **Google sign-in** uses `arctic` with the authorization-code flow, PKCE and a `state` value held in a short-lived HttpOnly cookie, through two routes: `/api/auth/google/start` and `/api/auth/google/callback`. It asks for `openid` and `email` only. The callback exchanges the code over TLS and reads the ID token's `sub`, `email` and `email_verified` claims.
- **Owner pinning:** the first successful sign-in needs a verified email equal to `OWNER_EMAIL` and stores Google's `sub` in the single-row `owner` table. Every later sign-in must present that same `sub` and a verified email equal to `OWNER_EMAIL`. An empty `OWNER_EMAIL` admits nobody.
- **Session kinds follow the way the session was made:** `google` (a Google sign-in, on any device) or `paired` (a QR pairing). Only `google` sessions can pair, approve and revoke.
- **Sessions:** a session is a `sessions` row plus the cookie `jobkit_session` holding a random 32-byte token (base64url), HttpOnly, Secure, SameSite=Lax, Path=/, with `Max-Age` equal to the session's remaining life. The row stores the token's SHA-256 hash, never the token. Columns: kind, label (from the user agent, for example "Windows · Chrome"), `created_at`, `last_seen_at`, `expires_at`, `approved_at`, and `google_auth_at`.
- **Lifetimes are absolute, never sliding:** a `google` session ends 30 days after it was created, a `paired` session 180 days after (ADR 0001, default for the phone). The cookie is set only when the session is created or rotated, which happens in route handlers and server actions, never while rendering a page.
- **Re-authentication** (the 5-minute rule below) runs Google sign-in from inside a `google` session: on success it updates that same row's `google_auth_at` and rotates the token (new token, new hash, same row).
- **`requireSession({ kind, googleAuthWithin })`** runs at the start of every server action and route handler. It hashes the cookie's token, loads the row, rejects a missing, expired or unapproved session, optionally requires a kind or a recent Google sign-in, and updates `last_seen_at` at most once an hour.
- **Cross-site requests:** route handlers that change state accept only requests whose `Origin` equals `APP_ORIGIN`; server actions rely on Next's own origin check as well.
- **Sign out** deletes the row. **Revoke** on the Devices page deletes another session's row.
- The proxy (`src/proxy.ts`) only redirects page requests that carry no session cookie to `/login`. The real check is `requireSession`, because Next documents that the proxy can be skipped.
- Exempt from the session check: `/login`, the Google start and callback routes, the `/pair` page shell, `/api/pair/redeem`, `/api/pair/status`, the manifest, icons, the service worker, and the two cron endpoints (B6), which check their own secrets.
- **Test sign-in:** end-to-end tests need a fake Google sign-in. Its route exists only in builds made with `JOBKIT_ENV=test`; a production build does not contain it, and a test checks that it returns 404 there.

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
- A QR code caught in a screenshot or a demo video is useless after two minutes or its first use. Someone who redeems it first still needs the code that only their own screen shows to be typed on the owner's laptop, so the owner, holding their own phone, sees the mismatch.

### B4. Model-call wrapper

- `callModel({ stage, jobId, model, system, content, schema, effort, maxTokens })` returns the parsed output and its usage, or a typed failure. The provider follows from the model ID.
  - **Claude:** `messages.parse` with `output_config.format = zodOutputFormat(schema)` and `output_config.effort`. Server-side refusal fallbacks are enabled in their default form if the API accepts them together with structured outputs; the implementation checks the current documentation first.
  - **Gemini:** a JSON-schema response format, then the same zod parse. The model ID is pinned at implementation after checking Google's current model list, and only the paid tier is used (ADR 0001 entry 2).
- The wrapper has no parameter for tools, so no stage can hand a tool to a model that reads post text.
- **Logging:** the wrapper inserts a `model_calls` row with outcome `started` before sending, then completes it: the model that actually answered (`response.model`), input, output, cache-read and cache-write tokens per iteration, cost in US dollars, end time, outcome, and the provider's request ID. A row left at `started` by a killed invocation is marked `abandoned` with unknown cost when the job is next claimed.
- **Costs** come from a price table in code, checked against the providers' pricing pages whenever the table changes: Claude Opus 5.5 at $4 per million input tokens and $20 per million output tokens (thinking is billed as output), Claude Sonnet 5.5 at $2 and $10, any model a refusal fallback can route to at its own rates, cache reads and writes at their published rates, and Gemini Flash at Google's published rate. Each fallback iteration is priced at the rates of the model that ran it. An unknown model ID records the cost as unknown and shows a warning on the Spend page.
- **Guard:** before each call the wrapper runs a guard injected by the composition root. In the app, the ledger supplies it to enforce the monthly cap. When the guard refuses, no request is sent and the outcome is `refused-cap`.
- **Retries:** the SDKs' own retries are switched off (`maxRetries: 0`). The wrapper retries once on a rate limit, a server error or a dropped connection, and never on a timeout, a refusal or any other client error. With a 120-second timeout per attempt, a stage's worst case is 240 seconds, inside Vercel's 300-second limit.
- **Refusal:** a `refusal` stop reason fails the stage at once, with no retry and the message "The model declined this post."
- **Caching:** the stable parts of each prompt (instructions, approved profile) come first and are marked for prompt caching.
- **Evaluations** use the same wrapper with their own composition: a local PGlite database seeded from `private/profile.yaml`, the `ANTHROPIC_EVALS_API_KEY`, and a guard enforcing the run's `--budget`. They never use `DATABASE_URL`, so evaluation spend never reaches the app's `model_calls` or its cap.

### B5. App shell and PWA

- Mobile-first layout with 16-pixel side gutters, dark theme, lime accent.
- Navigation: Jobs, New job, Stats, Spend, Profile (read-only view of approved facts) and Devices (`google` sessions only).
- The web app manifest has the name "jobkit", 192- and 512-pixel icons, `start_url` `/jobs`, `display: standalone`, and the `share_target` defined in the intake spec. It is served outside the session check.
- A minimal service worker exists because installability and the share target need one. It handles the share-target POST (intake spec) and caches nothing that holds personal data.

### B6. Keep-alive and the daily jobs

- `GET /api/cron/keepalive` accepts only `Authorization: Bearer <KEEPALIVE_SECRET>`. It runs three small queries and updates the `heartbeat` row, and can do nothing else. A GitHub Actions schedule calls it every 8 hours, through a GitHub environment restricted to the `main` branch that holds `KEEPALIVE_SECRET` and nothing else.
- `GET /api/cron/daily` accepts only `Authorization: Bearer <CRON_SECRET>`, which only Vercel holds. Vercel's cron calls it once a day. It touches the heartbeat and runs the retention purges that intake and ledger define.
- GitHub disables scheduled workflows in public repositories after 60 days without activity. If the repository goes public, the runbook says to re-enable the schedule; the daily Vercel run alone still makes a few database requests a day.

### B7. CI and the guard

- GitHub Actions on every push and pull request: `npm ci`, lint, typecheck, tests with the coverage threshold, build, and the guard below over the whole tree and over every commit in the push. These jobs get no secrets.
- `npm run prepare` sets `core.hooksPath` to `.githooks`. The pre-commit hook runs the same guard on staged changes. It blocks a path under `private/`, a `.env` file other than `.env.example`, a file larger than 1 MB, and content matching a key pattern: Anthropic keys (`sk-ant-`), Google API keys (`AIza`), Google OAuth client secrets (`GOCSPX-`), Supabase secret keys (`sb_secret_`), private-key headers, and long JWT-shaped strings.
- Before the repository is made public, a full-history scan runs (ADR 0001 entry 30).

### B8. Environment variables

Documented in `.env.example` with empty values:

- **App (Vercel and `.env.local`):** `OWNER_EMAIL`, `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL` (as `jobkit_app`, through the transaction pooler), `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Supabase's newer secret key format; the legacy `service_role` key is not used), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CRON_SECRET`, `KEEPALIVE_SECRET` and `JOBKIT_ENV` (`development`, `test` or `production`).
- **Laptop only (`.env.local`):** `DATABASE_BOOTSTRAP_URL`, `JOBKIT_APP_DB_PASSWORD` and `ANTHROPIC_EVALS_API_KEY`.

The owner sets real values; none goes in chat or git.

### B9. Jobs, states and the pipeline runner

Modules register stages; the runner owns their order, the job's state and the bookkeeping, not the stages' logic.

**Job states** (`jobs.state`) and their transitions, the single table every other spec cites:

| State | Meaning | Next states |
|---|---|---|
| `manual_run` | the job was assigned to the manual arm of the timing comparison (ledger spec); nothing uploads and no stage runs | `closed` (the owner taps Stop) |
| `uploading` | intake is receiving images | `queued`, `upload_failed` |
| `upload_failed` | the upload did not complete within 15 minutes, or its objects were missing; the page offers "Upload again" | `uploading` |
| `queued` | ready for the first stage | `extracting` |
| `extracting` | `extract` (post images or text) or `extract_questions` (form images) running | `needs_role_pick`, `checking`, `drafting` (new form questions on a ready kit), `stopped`, `failed` |
| `needs_role_pick` | waiting for the owner to pick a role | `checking`, `closed` |
| `checking` | `eligibility` running (code only, no model) | `needs_eligibility_decision`, `needs_kit_type`, `drafting`, `failed` |
| `needs_eligibility_decision` | waiting for Draft anyway or Skip | `needs_kit_type`, `drafting`, `closed` |
| `needs_kit_type` | the route is `other` or `unknown`; waiting for the owner to pick email, form or message | `drafting`, `closed` |
| `drafting` | `draft`, `address_read` and `address_checks` running together | `judging`, `failed` |
| `judging` | `judge` running | `kit_ready`, `failed` |
| `kit_ready` | the kit is ready for review | `extracting` (screenshots added), `drafting` (contact edited, another kit type, or new questions), `needs_role_pick` (the owner picks another role) |
| `stopped` | not a job post, or not in English | `extracting` (the owner confirms a post marked "not a job post"; never for language) |
| `closed` | the owner skipped it before a kit existed | none |
| `failed` | a stage failed; the page shows the stage, a readable reason and Retry | the failed stage's running state |

The application's outcome (sent, submitted, skipped, bounced) is the ledger's status, not a job state.

**Stage runs and idempotency:** each stage run is recorded in `job_stage_runs` with the stage, an input hash, its output, start and end times, and an attempt number. The input hash covers everything the stage reads: the job's image hashes and pasted text, the chosen role, the profile version, the contact the owner typed, the kit type. A stage whose output already exists for the same input hash reuses it without calling a model; new screenshots, another role or an edited contact produce a new hash and a fresh run.

**Leases instead of self-requests:**

- A job is advanced by whichever request finds it runnable (not in a waiting or final state): the upload confirmation, or the open job page and jobs list, which poll every 2 seconds and send `POST /api/jobs/<id>/advance` (a normal session-checked, origin-checked request) when the status reply says the job is runnable and unclaimed.
- `advance` claims the job's lease with one conditional update that succeeds only when no unexpired lease exists, sets the lease to expire 330 seconds later (longer than Vercel's 300-second limit, so a killed invocation's lease always lapses), replies 202, and runs the pipeline in Next's `after()`.
- The pipeline runs stages in order within that one invocation. Before starting a stage, it checks that the stage's worst case (240 seconds for a model stage) still fits before 280 seconds of invocation time; if not, it releases the lease and stops, and the next poll resumes it. It also stops at a waiting state.
- No request ever calls the app's own URL, so Vercel's loop detection and deployment protection never come into play.
- A stage started three times without finishing (killed invocations or retryable errors) moves the job to `failed`; Retry resets that stage's attempt count. A refusal fails at once.
- While no page is open, a job waits where it stopped and resumes when the owner opens the job or the jobs list.

**Times:**

- **Machine time** is the wall-clock time from the job's start (intake's clock) to `kit_ready`, minus the intervals the job spent in waiting states (`needs_role_pick`, `needs_eligibility_decision`, `needs_kit_type`) and between a failure and its Retry. Upload, cold starts and pauses between stages all count. The job page's poll adds at most 2 seconds before the kit appears.
- **Processing time** is the sum of stage-run durations, reported separately so the cost of waiting for the phone or a cold start is visible.
- **Concurrency inside a stage group:** in `drafting`, the runner starts `draft`, `address_read` and `address_checks` together and waits for all three; each is still recorded as its own stage run with its own input hash.

### B10. Acceptance criteria

1. On a fresh clone, `npm run check` passes with nothing but the `.env.example` defaults: tests use PGlite and fakes.
2. A Google account other than `OWNER_EMAIL`, an unverified email, or a different `sub` after the first sign-in cannot sign in; the owner's sign-in creates a `google` session whose row holds only the token's hash.
3. Session lifetimes are absolute: a `google` session is refused after 30 days and a `paired` one after 180, however often they are used; the cookie's `Max-Age` matches.
4. Re-authentication updates the same row's `google_auth_at` and rotates the token; the old token stops working.
5. A pairing token can be created only by a `google` session whose Google sign-in is at most 5 minutes old. It works exactly once, within two minutes, while its creating session exists; every failure returns the same message.
6. A redeemed `paired` session is refused everywhere until approved. Only the creating session can approve, only with the matching confirmation code and a Google sign-in still within 5 minutes; five wrong codes, Reject or 5 minutes without approval delete it.
7. In the end-to-end pairing test, no request URL and no server log line contains the token.
8. After a session is revoked, its next request is refused and redirected to sign-in. `paired` sessions cannot reach the Devices page, create tokens, approve or revoke (server-side checks).
9. A state-changing request with a foreign `Origin` is refused.
10. The test sign-in route returns 404 in a production build.
11. Every model call has exactly one `model_calls` row: inserted as `started` before sending and completed after, recording the answering model and each iteration's cost; a call refused by the guard sends nothing; a refusal is not retried; the SDK's own retries are off.
12. The wrapper's type signature has no way to pass tools (a type-level test fails to compile if one is added).
13. Evaluation runs write only to their local database and never touch the app's `model_calls` (tested with both compositions).
14. The keep-alive endpoint accepts only `KEEPALIVE_SECRET` and only touches the heartbeat; the daily endpoint accepts only `CRON_SECRET`; each rejects the other's secret.
15. CI runs lint, typecheck, tests with the coverage threshold, build and the guard over the tree and the pushed commits. The guard blocks a staged file under `private/` and staged strings shaped like each key pattern listed in B7.
16. Migrations apply cleanly to an empty PGlite database, and running them again changes nothing; every statement names the `jobkit` schema.
17. Runner: stages run in order inside one claimed invocation; a second `advance` while the lease is live is refused; a lapsed lease can be claimed again; an unchanged input hash reuses the stage's output without a model call, and a changed one runs it again; three unfinished starts move the job to `failed`, and Retry resumes; every transition outside the table is refused.
18. Machine time includes upload and pauses between stages and excludes waiting states and the time before a Retry; processing time is reported separately.
