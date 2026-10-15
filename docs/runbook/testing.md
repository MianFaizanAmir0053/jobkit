# Runbook: tests

Every command runs from the `jobkit` folder.

| Command | What it runs | Network or money |
|---|---|---|
| `npm run check` | lint, typecheck, then every unit and integration test | none |
| `npm run test:coverage` | the same tests with the 90% coverage bar on `src/core/**` (as CI does) | none |
| `npm run build` | `next build`, then `scripts/checkBuild.ts`, which fails any build that contains a test-only route | none |
| `npm run test:e2e` | Playwright end-to-end tests against a dev server in test mode | none |
| `npm run test:live` | contract tests against the real Supabase project and the Claude and Gemini APIs, by hand only | Supabase, and a few cents from the evaluation keys; needs `.env.ops.local` and `.env.local` |

## Unit and integration tests

Integration tests (`*.int.test.ts`) boot an in-memory Postgres (PGlite) per file, which keeps a CPU core busy for several seconds. Vitest therefore runs files on half the logical CPUs, and allows 30 seconds per test and per hook. On a laptop that is busy with other work, a run can still slow down; check the load before raising either limit. A test or hook that opens a fresh PGlite data folder on disk needs longer: on top of the usual start, PGlite writes the new database to the folder, nearly a thousand files one by one, and that slows down most on a busy laptop. Give it 60 seconds of its own, with a comment saying why.

## End-to-end tests

`npm run test:e2e` starts `next dev` on port 3300 with `JOBKIT_ENV=test` (an in-memory database, plus the test-only sign-in and reset routes) and drives the Chrome already installed on the laptop, with a fresh temporary profile and no window. Playwright downloads no browser. Each test empties the database first. Everything the dev server prints goes to `.data/e2e/server.log`, which the pairing test reads to check that no pairing token reaches a log line.

If Chrome is missing, install Chrome rather than Playwright's own browsers.

The dev server, and any local run not set up as production, refuses to start when the shell or a `.env` file holds a value only production or the production scripts hold: the app's model keys, `SUPABASE_SECRET_KEY`, `CRON_SECRET`, `KEEPALIVE_SECRET`, `JOBKIT_APP_DB_PASSWORD`, or a production address that leaves the laptop (platform spec B8; the list follows `src/server/env.ts`). The error names the variable; remove it and start again.

## Live contract tests

These touch the real Supabase project or spend real money, so they run only by hand, with the owner's go-ahead, one file at a time:

- `npx vitest run --mode live src/adapters/anthropic.live.test.ts` (only with a Claude key; no stage runs on Claude now): Claude Opus 5.5 on `ANTHROPIC_EVALS_API_KEY` from `.env.local`, usually a few cents and at most about fifteen. It prints the longest silence while the model thinks with its thinking hidden; the wrapper gives up after 45 silent seconds (platform spec B4).
- `npx vitest run --mode live src/adapters/gemini.live.test.ts`: Gemini 3.8 Flash on `GEMINI_EVALS_API_KEY`, about a cent. It reads an image at the high thinking level and prints the longest silence too.
- `src/adapters/pg.live.test.ts`, `src/adapters/supabaseStorage.live.test.ts` and `src/core/platform/pairing.live.test.ts` read `.env.ops.local` and use the Supabase project.
