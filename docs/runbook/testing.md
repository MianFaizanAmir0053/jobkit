# Runbook: tests

Every command runs from the `jobkit` folder.

| Command | What it runs | Network or money |
|---|---|---|
| `npm run check` | lint, typecheck, then every unit and integration test | none |
| `npm run test:coverage` | the same tests with the 90% coverage bar on `src/core/**` (as CI does) | none |
| `npm run build` | `next build`, then `scripts/checkBuild.ts`, which fails any build outside `JOBKIT_ENV=test` that contains a test-only route | none |
| `npm run test:e2e` | Playwright end-to-end tests against a dev server in test mode | none |
| `npm run test:live` | contract tests against the real Supabase project, by hand only | Supabase; needs `.env.ops.local` |

## Unit and integration tests

Integration tests (`*.int.test.ts`) boot an in-memory Postgres (PGlite) per file, which keeps a CPU core busy for several seconds. Vitest therefore runs files on half the logical CPUs, and allows 30 seconds per test and per hook. On a laptop that is busy with other work, a run can still slow down; check the load before raising either limit.

## End-to-end tests

`npm run test:e2e` starts `next dev` on port 3300 with `JOBKIT_ENV=test` (an in-memory database, plus the test-only sign-in and reset routes) and drives the Chrome already installed on the laptop, with a fresh temporary profile and no window. Playwright downloads no browser. Each test empties the database first. Everything the dev server prints goes to `.data/e2e/server.log`, which the pairing test reads to check that no pairing token reaches a log line.

If Chrome is missing, install Chrome rather than Playwright's own browsers.
