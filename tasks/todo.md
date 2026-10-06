# Task list: jobkit MVP

Every task is test-first and ends with `npm run check` green. "AC" refers to the acceptance criteria in the named spec. Scope: S is 1-2 files, M is 3-5.

## Phase 0: Foundation

- [ ] **Task 1: Scaffold and tooling**
  - Acceptance: Next 16, TypeScript strict, Tailwind v4, shadcn, Vitest, ESLint and Prettier at pinned majors; `.gitignore` covers `private/`, every `.env*` except `.env.example`, and build output; `.env.example` lists platform B8; a trivial test passes. Before any Next code, the guides in `node_modules/next/dist/docs/` are read and anything that changes the specs' assumptions is noted.
  - Verify: `npm run check`; `npm run build`.
  - Depends on: none. Files: package.json, tsconfig.json, vitest.config.ts, eslint.config.mjs, .gitignore, .env.example. Scope: M.
- [ ] **Task 2: Guard and CI**
  - Acceptance: platform AC15. Fixture keys are built at run time, never committed in a key-like form.
  - Verify: `npm test`; a dry commit of a planted path is refused.
  - Depends on: 1. Files: scripts/guard.ts, scripts/guard.test.ts, .githooks/pre-commit, .github/workflows/ci.yml. Scope: M.
- [ ] **Task 3: Database layer and bootstrap**
  - Acceptance: platform AC16; `Db` port with PGlite and pg adapters; `{{schema}}` placeholder; bootstrap script; atomic-claim helper; live contract test behind `JOBKIT_LIVE=1`.
  - Verify: `npm test`; migrations twice on PGlite.
  - Depends on: 1. Files: src/core/ports.ts, src/adapters/pglite.ts, src/adapters/pg.ts, scripts/migrate.ts, scripts/bootstrap.ts, db/migrations/0001_platform.sql. Scope: M.
- [ ] **Task 4: Google sign-in and sessions**
  - Acceptance: platform AC2, AC3, AC4, AC8, AC9, AC10; `requireSession` on pages, layouts, actions and route handlers.
  - Verify: `npm test`; integration tests with a fake Google token endpoint.
  - Depends on: 3. Files: src/core/platform/sessions.ts, src/app/api/auth/google/*, src/server/session.ts, src/proxy.ts, tests. Scope: M.
- [ ] **Task 5: QR pairing**
  - Acceptance: platform AC5, AC6, AC7.
  - Verify: `npm test`; Playwright pairing test with two browser contexts, including an unapproved phone loading `/jobs`.
  - Depends on: 4. Files: src/core/platform/pairing.ts, src/app/devices/*, src/app/pair/*, src/app/api/pair/*, e2e/pairing.spec.ts. Scope: M.
- [ ] **Task 6: Baseline page and Stats shell**
  - Acceptance: Start and Stop record a pre-real-use baseline run with route, company and role; the Stats shell shows its count, median and 90th percentile.
  - Verify: `npm test`.
  - Depends on: 4. Files: src/core/ledger/baseline.ts, src/app/baseline/*, src/app/stats/page.tsx, db/migrations/0002_baseline.sql. Scope: S.
- [ ] **Task 7: Deploy skeleton**
  - Acceptance: the Vercel project is live with the owner's environment values; bootstrap and migrate ran on Supabase from `.env.ops.local`; platform AC14; the keep-alive workflow uses the repository secret; `vercel.json` holds the daily cron; [the runbook](../docs/runbook/setup.md) matches what was done.
  - Verify: the owner signs in on the laptop and pairs the phone on the live site; both cron endpoints answer 401 without their secrets.
  - Depends on: 2, 5, 6. Files: vercel.json, src/app/api/cron/*, .github/workflows/keepalive.yml, docs/runbook/setup.md. Scope: M.
- [ ] **Checkpoint A** — tests green; sign-in, pairing and baseline timing on real devices; doubt review of sessions and pairing; merge to `main`.

## Phase 1: Capture

- [ ] **Task 8: Phone spike**
  - Acceptance: the PWA installs on the owner's phone; the share target delivers images through the service worker, or the failure is recorded and the server switch set off; empty and link-only shares are refused.
  - Verify: by hand on the phone; result in docs/runbook/spikes.md.
  - Depends on: 7. Files: public/sw.js, src/app/manifest.ts, the share-switch route, docs/runbook/spikes.md. Scope: S.
- [ ] **Task 9: Intake upload path**
  - Acceptance: intake AC1 to AC12.
  - Verify: `npm test`; Playwright upload test with the local storage adapter.
  - Depends on: 8, 10. Files: src/core/intake/*, src/app/jobs/new/*, src/app/api/jobs/*, src/adapters/supabase-storage.ts, src/adapters/local-storage.ts. Scope: M (split into 9a client encoding and 9b server path if it grows).
- [ ] **Task 10: Runner**
  - Acceptance: platform AC17, AC18, AC19.
  - Verify: `npm test` with fake stages and a fake clock.
  - Depends on: 3. Files: src/core/platform/runner.ts, src/core/platform/jobStates.ts, src/app/api/jobs/[id]/advance/route.ts, db/migrations/0003_jobs.sql. Scope: M.
- [ ] **Task 11: Model wrapper**
  - Acceptance: platform AC11, AC12, AC13.
  - Verify: `npm test`; adapter contract tests behind `JOBKIT_LIVE=1`, with the owner's approval for a few cents of spend.
  - Depends on: 3. Files: src/core/platform/models.ts, src/adapters/anthropic.ts, src/adapters/gemini.ts, src/adapters/fake-llm.ts, src/core/platform/prices.ts. Scope: M.
- [ ] **Task 12: Profile**
  - Acceptance: profile AC1 to AC7, with the shared skill vocabulary and region table.
  - Verify: `npm test`; `npm run profile:seed` on the sample profile.
  - Depends on: 3. Files: src/core/profile/*, src/core/shared/skills.ts, src/core/shared/regions.ts, scripts/profile-seed.ts, src/app/profile/page.tsx, evals/synthetic/profile.sample.yaml. Scope: M.
  - Owner, in parallel: once `.gitignore` exists, Claude Code moves the drafted profile to `private/profile.yaml`; the owner approves facts and writes the rest.
- [ ] **Checkpoint B** — a phone upload creates a job; fake stages advance through the state table.

## Phase 2: Extraction and first measurement

- [ ] **Task 13: Extraction core** — extraction AC1, AC2, AC3, AC8; record schema, sentinels, contact checks, phrase backstop, tiling. Depends on 11, 12. Scope: M.
- [ ] **Task 14: `extract`, stops and override, role pick, `extract_questions`** — extraction AC4, AC5, AC6, AC7, AC12. Depends on 9, 10, 13. Scope: M.
- [ ] **Task 15: `address_read`** — extraction AC9, AC10. Depends on 14. Scope: S.
- [ ] **Task 16: `eligibility`** — extraction AC11; the decision screen. Depends on 12, 13. Scope: S.
- [ ] **Task 17: Evaluations, part 1** — evals AC1 to AC7 for extraction, the synthetic renderer and cases. Depends on 13, 14, 15. Scope: M (split: 17a import and labelling page, 17b runner and scorer).
- [ ] **Task 18: Live extraction evaluation** — the owner approves the spend; report reviewed; stage latency and effort settings recorded. Depends on 17 and the owner's blind test labels. Scope: S.
- [ ] **Checkpoint C** — assumption 1 measured; latency against the stage budget; owner review; doubt review.

## Phase 3: Drafting

- [ ] **Task 19: Drafting core and `validate`** — drafting AC3 to AC8, AC10, AC12, AC13. Depends on 12, 13. Scope: M.
- [ ] **Task 20: `draft` and `draft_answers`** — drafting AC1, AC2, AC11. Depends on 19, 10, 11. Scope: M.
- [ ] **Task 21: `judge`** — drafting AC9. Depends on 20. Scope: S.
- [ ] **Task 22: Evaluations, part 2** — the frozen judge set, judge metrics, gap coverage, the McNemar comparison; a live run within budget. Depends on 21, 17. Scope: M.
- [ ] **Checkpoint D** — a kit end to end from a real screenshot; production machine time against 60 seconds; owner decision if missed; doubt review.

## Phase 4: Review and ledger

- [ ] **Task 23: Ledger core** — ledger AC1 to AC4, AC10. Depends on 3. Scope: M.
- [ ] **Task 24: `address_checks`** — review AC5. Depends on 10. Scope: S.
- [ ] **Task 25: Job page, part 1** — review AC6, AC9; waiting-state screens, banners, contact panel, checklist, fit table. Depends on 21, 23, 24. Scope: M.
- [ ] **Task 26: Job page, part 2** — review AC1, AC2, AC4, AC11; drafting AC13; block editor. Depends on 25. Scope: M.
- [ ] **Task 27: Handoffs** — review AC3, AC7, AC8, AC10; the tap-count spike, recorded. Depends on 26. Scope: M.
- [ ] **Task 28: Stats and Spend** — ledger AC5 to AC8; intake AC12. Depends on 23, 27. Scope: M.
- [ ] **Task 29: Retention purges** — intake AC9; ledger AC9. Depends on 23, 9. Scope: S.
- [ ] **Task 30: End-to-end and accessibility** — review AC12, AC13. Depends on 27, 28. Scope: S.
- [ ] **Checkpoint E** — real use starts at the first handoff; doubt review.

## Phase 5: Measure and write up

- [ ] **Task 31: Final evaluation** — the blind test split with `--final`; the aggregate summary approved by the owner. Depends on 22 and real use. Scope: S.
- [ ] **Task 32: Write-up** — README case study and Portfolio entry draft; full-history scan before anything is published. Depends on 31. Scope: S.
- [ ] **Checkpoint F** — success criteria on the first 20 real uses; decide milestone 2.
