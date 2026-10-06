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

- Migrations are SQL files `db/migrations/NNNN_<name>.sql`, forward-only, applied in order and recorded in `schema_migrations`. The same files run on PGlite and on Supabase Postgres.
- The `Db` port offers `query(sql, params)` and `tx(fn)`. The production adapter uses a `pg` pool against Supabase's transaction pooler, with no named prepared statements.
- jobkit has its own Supabase project (amendment A6). Every jobkit table lives in a Postgres schema named `jobkit`, used through a role `jobkit_app` that has no rights elsewhere.
- Supabase's Data API does not expose the `jobkit` schema, and every jobkit table has row-level security enabled with no policies, so the public API keys read nothing even if exposure is switched on by mistake. Only the server's `DATABASE_URL` connection reaches the data.
- Platform owns these tables: `sessions`, `pairing_tokens`, `model_calls`, `heartbeat` and `schema_migrations`. Other modules add theirs in their own migrations.

### B2. Owner sign-in and sessions

- **Google sign-in** uses `arctic` with the authorization-code flow, PKCE and a `state` value held in a short-lived HttpOnly cookie. It asks for `openid` and `email` only. The callback exchanges the code over TLS, reads the ID token's `email` and `email_verified` claims, and admits only a verified email equal to `OWNER_EMAIL`. An empty `OWNER_EMAIL` admits nobody. The Google client lives in a new Google Cloud project, "jobkit".
- **Sessions:** a successful sign-in creates a `sessions` row and sets the cookie `jobkit_session` to a random 32-byte token (base64url), HttpOnly, Secure, SameSite=Lax, Path=/. The row stores the token's SHA-256 hash, never the token. Columns: kind (`laptop` or `phone`), label (from the user agent, for example "Windows · Chrome"), `created_at`, `last_seen_at`, `expires_at`, `approved_at`, and `google_auth_at` (the time of the last Google sign-in on this session).
- **Lifetimes:** a laptop session lasts 30 days from its last use, a phone session 180 days; the expiry slides at most once a day.
- **`requireSession({ kind, googleAuthWithin })`** runs at the start of every server action and route handler. It hashes the cookie's token, loads the row, rejects a missing, expired or unapproved session, optionally requires a kind or a recent Google sign-in, and updates `last_seen_at` at most once an hour.
- **Cross-site requests:** route handlers that change state accept only requests whose `Origin` equals `APP_ORIGIN`; server actions rely on Next's own origin check as well.
- **Sign out** deletes the row. **Revoke** on the Devices page deletes another session's row.
- The proxy (`src/proxy.ts`) only redirects page requests that carry no session cookie to `/login`. The real check is `requireSession`, because Next documents that the proxy can be skipped.
- Exempt from the session check: `/login`, the Google start and callback routes, the `/pair` page shell and its redeem endpoint, the manifest, icons, the service worker, and `/api/cron/keepalive` (which checks its own secret).

### B3. QR pairing

1. On the Devices page, a laptop session taps "Pair a phone". If its last Google sign-in is more than 5 minutes old, it goes through Google sign-in again first, with the account chooser shown.
2. The server creates a token of 32 random bytes, stores its SHA-256 hash with `expires_at` two minutes ahead and the creating session's ID, and returns it once. The page renders a QR code for `https://<APP_ORIGIN>/pair#t=<token>` with a countdown and offers a fresh code when it expires.
3. The phone's camera opens the link. The page reads the fragment, removes it at once with `history.replaceState`, and posts the token in the request body to `/api/pair/redeem`.
4. In one transaction the server accepts the token only if it exists, has not expired, has not been used, and its creating session still exists and is a laptop session. It marks the token used and creates a phone session with `approved_at` empty, and sets the phone's cookie. The phone shows "Approve this phone on your laptop" and polls.
5. The laptop's Devices page shows the new device, "Approve Android · Chrome?", with Approve and Reject. Approve sets `approved_at`; Reject deletes the session. A pending session not approved within 5 minutes is deleted.
6. Once approved, the phone moves on to the jobs list.

Rules:

- Every redemption failure returns the same message, "This code has expired. Make a new one on your laptop." No failure reveals which check failed.
- Tokens never appear in a URL query string or in server logs. Brute force needs no rate limit: a token carries 256 bits and lives two minutes.
- Phone sessions cannot create pairing tokens, approve devices or revoke sessions.
- A QR code caught in a screenshot or a demo video is useless after two minutes or after its first use, and even a redeemed code yields nothing without the owner's Approve tap on the laptop.

### B4. Model-call wrapper

- `callModel({ stage, jobId, model, system, content, schema, effort, maxTokens })` returns the parsed output and its usage, or a typed failure. The provider follows from the model ID.
  - **Claude:** `messages.parse` with `output_config.format = zodOutputFormat(schema)` and `output_config.effort`.
  - **Gemini:** a JSON-schema response format, then the same zod parse. The model ID is pinned at implementation after checking Google's current model list, and only the paid tier is used (ADR 0001 entry 2).
- The wrapper has no parameter for tools, so no stage can hand a tool to a model that reads post text.
- Every call, successful or not, writes one `model_calls` row: stage, job ID, model, input, output, cache-read and cache-write tokens, cost in US dollars, start and end times, outcome, and the provider's request ID.
- Costs come from a price table in code, checked against the providers' pricing pages whenever the table changes: Claude Opus 5.5 at $4 per million input tokens and $20 per million output tokens (thinking is billed as output), Claude Sonnet 5.5 at $2 and $10, cache reads and writes at their published rates, and Gemini Flash at Google's published rate.
- Before each call the wrapper runs a guard injected by the composition root. The ledger supplies it to enforce the monthly cap. When the guard refuses, no request is sent and the outcome is recorded as `refused-cap`.
- The stable parts of each prompt (instructions, approved profile) come first and are marked for prompt caching.
- Calls time out after 120 seconds and are retried once on a rate limit, a server error or a dropped connection; never on other client errors.
- A `refusal` stop reason fails the stage with the message "The model declined this post." Server-side refusal fallbacks are enabled if the API accepts them together with structured outputs; the implementation checks the current documentation first.

### B5. App shell and PWA

- Mobile-first layout with 16-pixel side gutters, dark theme, lime accent.
- Navigation: Jobs, New job, Stats, Spend, Profile (read-only view of approved facts) and Devices (laptop only).
- The web app manifest has the name "jobkit", 192- and 512-pixel icons, `start_url` `/jobs`, `display: standalone`, and the `share_target` defined in the intake spec. It is served outside the session check.
- A minimal service worker exists because installability and the share target need one. It handles the share-target POST (intake spec) and caches nothing that holds personal data.

### B6. Keep-alive and the daily jobs

- `GET /api/cron/keepalive` accepts only `Authorization: Bearer <CRON_SECRET>` and updates the single `heartbeat` row.
- Two callers keep Supabase's seven-day pause from triggering: a Vercel cron once a day, and a GitHub Actions schedule every 8 hours. The schedule is the only workflow given a secret, `CRON_SECRET`, which can do nothing but touch the heartbeat.
- The Vercel cron's daily run also performs the retention purges that intake and ledger define.

### B7. CI and the pre-commit guard

- GitHub Actions on every push and pull request: `npm ci`, lint, typecheck, tests with the coverage threshold, build, and the guard below over the whole tree. These jobs get no secrets.
- `npm run prepare` sets `core.hooksPath` to `.githooks`. The pre-commit hook blocks the commit when a staged path is under `private/`, is a `.env` file other than `.env.example`, or is larger than 1 MB, or when staged content matches a key pattern (Anthropic and Gemini keys, Google OAuth client secrets, private-key headers, Supabase service-role keys, long JWT-shaped strings).

### B8. Environment variables

Documented in `.env.example` with empty values: `OWNER_EMAIL`, `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CRON_SECRET`, `INTERNAL_SECRET` (the runner's advance requests) and `JOBKIT_ENV` (`development`, `test` or `production`). Evaluation runs on the laptop also read `ANTHROPIC_EVALS_API_KEY`, the key of the separate "jobkit-evals" workspace. The owner sets real values in Vercel and in `.env.local`; none goes in chat or git.

### B9. Job pipeline runner

Modules register stages; the runner owns their order and the bookkeeping, not their logic.

**Job states** (`jobs.state`):

| State | Meaning |
|---|---|
| `uploading` | intake is receiving images |
| `queued` | ready for the first stage |
| `extracting` | `extract` (and `extract_questions`) running |
| `needs_role_pick` | waiting for the owner to pick a role |
| `checking` | `address_read`, `address_checks` and `eligibility` running |
| `needs_eligibility_decision` | waiting for Draft anyway or Skip |
| `drafting` | `draft` running |
| `judging` | `judge` running |
| `kit_ready` | the kit is ready for review |
| `stopped` | not a job post, or not in English |
| `skipped` | the owner skipped it |
| `failed` | a stage failed three times; the job shows the stage and a readable reason, and a Retry button |

Rules:

- Each stage runs in its own function invocation, so no single invocation nears Vercel's 300-second limit even when one model call takes its full 120 seconds.
- When a stage finishes, it records its output and the new state, then triggers the next stage with an internal request to `POST /api/jobs/<id>/advance`, authenticated by `INTERNAL_SECRET` and sent after the response with Next's `after()`.
- Stages are idempotent: a stage whose output already exists returns it without calling a model again.
- Waiting states stop the chain; the owner's answer restarts it.
- A job with no progress for 150 seconds outside a waiting state counts as stalled. Opening the job or the jobs list re-triggers it. After three failed attempts a stage moves the job to `failed`. Retry starts again from the failed stage.
- Every stage records its start and end times. **Machine time** is the sum of stage durations, so time spent waiting for the owner, or between a failure and its Retry, is never counted.

### B10. Acceptance criteria

1. On a fresh clone, `npm run check` passes with nothing but the `.env.example` defaults: tests use PGlite and fakes.
2. A Google account other than `OWNER_EMAIL`, or an unverified email, cannot sign in; the owner's sign-in creates a laptop session whose row holds only the token's hash.
3. A pairing token can be created only by a laptop session whose Google sign-in is at most 5 minutes old. It works exactly once, within two minutes, while its creating session exists. A second use, an expired or unknown token, or a token whose creating session was deleted all fail with the same message.
4. A redeemed phone session is refused everywhere until the laptop approves it; Reject deletes it; an unapproved session is deleted after 5 minutes.
5. In the end-to-end pairing test, no request URL and no server log line contains the token.
6. After a session is revoked, its next request is refused and redirected to sign-in.
7. Phone sessions cannot reach the Devices page, create tokens, approve or revoke (server-side checks, not only hidden buttons).
8. A state-changing request with a foreign `Origin` is refused.
9. Every model call writes exactly one `model_calls` row with tokens and cost, on success and on failure; a call refused by the guard sends nothing.
10. The wrapper's type signature has no way to pass tools (a type-level test fails to compile if one is added).
11. The keep-alive endpoint rejects a request without the secret and updates the heartbeat with it.
12. CI runs lint, typecheck, tests with the coverage threshold, build and the guard. The guard blocks a staged file under `private/` and a staged string shaped like an API key.
13. Migrations apply cleanly to an empty PGlite database, and running them again changes nothing.
14. The runner runs registered stages in order, one per invocation. Re-running a finished stage makes no model call. A stalled job is re-triggered when the owner opens it. Three failures move the job to `failed`, and Retry resumes from that stage. An `advance` request without the internal secret is refused. Machine time excludes waiting states.
