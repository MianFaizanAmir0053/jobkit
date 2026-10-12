# Task list: jobkit MVP

Every task is test-first and ends with `npm run check` green (platform AC1 holds after every task). "Owns" lists the acceptance criteria (AC) a task must make pass; each criterion in the eight MVP specs has exactly one owner. Scope: S is 1–2 files, M is 3–5. Migrations take the next free number when their task is built (`NNNN` below), since tasks may land in a different order.

## Thin local path first (the owner's choice, 2026-10-12)

The owner wants to try a job on the laptop as soon as possible, so the thinnest path to a testable email draft is built before the remaining tasks, in this order. Each step builds the part of its tasks the path needs, test-first and reviewed as usual; the rest of each task follows in plan order afterwards. Everything runs with `npm run dev` and the local database (no deploy). The owner's side is [docs/runbook/local.md](../docs/runbook/local.md): a Google client for localhost, the evaluation key, and approving profile facts.

- [ ] **TP1: Extraction core** (Task 15): the record with `caseless` enum fields, tiles, contact checks, the phrase backstop, the review's fixes; merged from `feat/extraction-core`.
- [x] **TP2: Intake on the laptop** (parts of Tasks 12 and 13): job images and pasted text, `POST /api/jobs`, the development storage routes, confirming an upload (which queues the job and starts the runner), and a New job page that scales an image wider than 2,576 pixels down before uploading it. No arms before real use, as the ledger spec has it.
  - Done (2026-10-12), after one review: confirm checks each upload's size, SHA-256, type and upright size against what was declared; request bodies are read with a cap; the local upload route checks its token before reading and keeps it until the file is written, and tokens expire after two hours; `clientElapsedMs` is capped at a day; `received_at` is the route's arrival; the height limit is checked on the server too, on the image as uploaded (my reading of the spec: after any scaling to 2,576 wide); the tile formula moved to `src/core/shared/tileGeometry.ts`, so intake no longer imports extraction; a test keeps server code out of everything a "use client" file reaches.
  - After a second review: confirm checks sizes only, from storage's metadata, as the spec says, and says when a job ran out of upload time; extract checks each image's hash when it reads the bytes and cuts tiles by the stored image's own size, so the limits hold for what was uploaded. The page times out its requests, sizes each upload's timeout to the file, stops before the server's 15 minutes, and says when the job may have started. The 24-hour clock cap is in intake's core. The boundary test reads files with the TypeScript parser.
  - Left for Task 12 and 13: an idempotency key per Start, so a lost answer to `POST /api/jobs` cannot create a second job (needs a column on `jobs`; until then the page says to check the Jobs list first); "the input kind" in `POST /api/jobs`; storing a URL found in pasted text as a reference; resume after a reload (`upload-urls`). Spec wording to settle at the next checkpoint: B2's list of routes without a session check should name the local-only storage routes, which stand in for signed URLs.
- [x] **TP3: `extract`** (part of Task 16): the prompt with its untrusted-data markers, tiles from the stored images, the record's checks and the backstop, the stops, and the role pick.
  - Done (2026-10-12): `extract.ts`, `prompt.ts` and `owner.ts` (confirm a post, pick a role, Skip at the pick, the chosen role), migration 0012, and every image block marked `oversized_image: "error"`. The routes for the owner's answers come with the job page (TP5). After one review: IDs are numbered by position after the checks, a post with no role found stops with the record kept and "Read it again" (the owner's choice, specs updated), a passing storage error starts the stage again instead of reading as a missing screenshot, a role pick holds only for the extraction it was made on (migration 0013), and the prompt hash covers the output schema. Known trade-off: the runner starts a stage again at once after a timeout or an outage, so a minute-long overload can use all three starts; Retry then starts afresh. Left for Task 16: skill and place normalisation through the shared tables, `extract_questions`, `address_read`, eligibility proper, and Skip at a role pick returning to `kit_ready` when another role has a kit.
- [x] **TP4: `draft`** (parts of Tasks 22 and 23): an email draft from the approved facts and the chosen role, with gaps flagged. Eligibility and the judge pass through, and the address stages are left out, each noted on the job page (the owner's choice).
  - Done (2026-10-12): `src/core/drafting/{kit,build,fit,validate,prompt,draftStage,judgeStage}.ts` and `src/core/extraction/eligibility.ts`. Every route gets an email kit for now. `validate` covers citations, the fit check, gap lines, the word limit, the accepted keyword, AI-addressed lines, reference leaks, "Needs your line" and sensitive topics; topic questions, short answers and form and message kits wait for Tasks 22 and 30. A language or "other" requirement marked met is flagged for the owner's confirmation but counts as met until the review page has its tick. The extract prompt now asks for {name} and {role} in a subject format, and the S01 fixture says so.
- [ ] **TP5: Job page and the email** (parts of Tasks 26 and 27): polling `advance`, the steps as they run, Retry and Skip, the role pick, the email with copy buttons, Open in Gmail and Mark sent, and a jobs list.
- [ ] **TP6: The owner's run-through** on the laptop, with the local runbook.

## Phase 0: Foundation and spikes (days 1–3)

- [x] **Task 1: Scaffold and tooling** — Owns: platform AC1.
  - Next 16, TypeScript strict, Tailwind v4, shadcn, Vitest, ESLint and Prettier at pinned majors; `.env.example` lists platform B8. Before any Next code, read the guides in `node_modules/next/dist/docs/` and note anything that changes the specs' assumptions in `docs/runbook/next16-notes.md`.
  - Verify: `npm run check`; `npm run build`. Depends on: none. Files: package.json, tsconfig.json, vitest.config.ts, eslint.config.mjs, .env.example. Scope: M.
- [x] **Task 2: Guard and CI** — Owns: platform AC15.
  - Fixture keys are built at run time, never committed in a key-like form.
  - Verify: `npm test`; a dry commit of a planted path is refused. Depends on: 1. Files: scripts/guard.ts, scripts/guard.test.ts, .githooks/pre-commit, .github/workflows/ci.yml. Scope: M.
- [x] **Task 3: Database, storage and composition** — Owns: platform AC16.
  - `Db` and `Storage` ports; PGlite, pg, local-storage and Supabase-storage adapters; `{{schema}}` placeholder; migration runner and bootstrap (local by default, `--prod` with typed confirmation, bucket creation); atomic-claim helper; `src/server/container.ts`; live contract test in `--mode live`.
  - Verify: `npm test`; migrations twice on PGlite. Depends on: 1. Files: src/core/ports.ts, src/adapters/{pglite,pg,local-storage,supabase-storage}.ts, scripts/{migrate,bootstrap}.ts, db/migrations/0001_platform.sql, src/server/container.ts. Scope: M (two commits if needed).
- [x] **Task 4: Google sign-in, sessions and app shell** — Owns: platform AC2, AC3, AC4, AC9, AC10.
  - App shell and navigation, with a `/jobs` page that loads (empty) data through `requireSession`.
  - Verify: `npm test`; integration tests with a fake Google token endpoint. Depends on: 3. Files: src/core/platform/sessions.ts, src/app/api/auth/google/*, src/server/session.ts, src/proxy.ts, src/app/(app)/layout.tsx, src/app/(app)/jobs/page.tsx. Scope: M.
- [x] **Task 5: QR pairing and Devices** — Owns: platform AC5, AC6, AC7, AC8.
  - Verify: `npm test`; Playwright with two browser contexts, including an unapproved phone loading `/jobs` and a test page, checking that no data reaches the response; every data read goes through the data access layer's `requireSession`, never a layout check (docs/runbook/next16-notes.md). Depends on: 4. Files: src/core/platform/pairing.ts, src/app/(app)/devices/*, src/app/pair/*, src/app/api/pair/*, e2e/pairing.spec.ts. Scope: M.
- [x] **Task 6: Baseline page** — Owns: none (ledger "Timing comparison", pre-real-use part).
  - Start and Stop record a pre-real-use baseline run with route, company and role; the page shows count, median and 90th percentile.
  - Verify: `npm test`. Depends on: 4. Files: src/core/ledger/baseline.ts, src/app/(app)/baseline/*, db/migrations/NNNN_baseline.sql. Scope: S.
- [ ] **Task 7: Deploy skeleton** — Owns: platform AC14.
  - Vercel project live from `main` (merge after this task) with Production-scoped variables; bootstrap and migrate run on Supabase with `--prod`; keep-alive workflow with the repository secret; daily cron in `vercel.json`; the runbook matches what was done.
  - Code done: the cron endpoints, `vercel.json`, the keep-alive workflow and the runbook. The deploy itself waits for the owner's accounts (runbook steps 2 to 8), then Claude pushes, bootstraps and migrates with `--prod`, and the owner runs step 11.
  - Verify: the owner signs in on the laptop and pairs the phone on the live site; both cron endpoints answer 401 without their secrets. Depends on: 2, 5, 6. Files: vercel.json, src/app/api/cron/*, .github/workflows/keepalive.yml, docs/runbook/setup.md. Scope: M.
- [ ] **Task 8: Spikes** — Owns: none.
  - On the owner's phone: PWA install; the share target through the service worker, recorded as working or not, with the server switch set accordingly. A static test page with both Gmail handoffs (`mailto:` and Web Share with a dummy PDF), tap counts recorded, mechanism chosen. On Vercel: a 200-second `after()` run to confirm the function limit. Jobs from spikes are marked as test jobs.
  - Code done: the manifest and icons, the service worker with the spike's share report, the security and service-worker headers, the spike page with both handoffs and the 200-second `after()` run, and `docs/runbook/spikes.md` with the steps and blank results. The spikes themselves run once the deploy is live.
  - Verify: results in `docs/runbook/spikes.md`. Depends on: 7. Files: public/sw.js, src/app/manifest.ts, src/app/(app)/spike/*, docs/runbook/spikes.md. Scope: S.
- [ ] **Checkpoint A (day 3)** — device tests by the owner; doubt review of sessions and pairing; merge.

## Phase 1: Capture, ledger and profile (days 3–5)

- [x] **Task 9: Runner** — Owns: platform AC17, AC18.
  - States with kinds, pending stage, `job_state_changes`, leases, per-stage input hashes, attempts, Retry and Skip, timeouts on status read.
  - Verify: `npm test` with fake stages and a fake clock. Depends on: 3. Files: src/core/platform/{runner,jobStates,times}.ts, src/app/api/jobs/[id]/advance/route.ts, db/migrations/NNNN_jobs.sql. Scope: M.
  - Done (2026-10-11), after two reviews: `jobStates.ts` (the table), `jobs.ts` (create, move, Retry, Skip, the upload timeout, status reads), `runner.ts`, `times.ts`, `POST /api/jobs/<id>/advance`, migration 0010. Model calls and applications now reference jobs, so tests create their jobs first (`insertTestJobs`).
  - Owner's decisions (2026-10-11, 2026-10-12): of an unpolled gap the first 10 seconds count as machine time and only the rest is paused, since a poll's request and any cold start come on top of the 5-second slow poll; the upload timeout runs 15 minutes from each time the job began uploading. Spec corrections: a model stage's worst case is 225 seconds (the wrapper counts the input first); three starts count since the stage last finished.
  - For later tasks: intake creates jobs with `createJob`, moves `uploading` → `queued` at confirmation, then claims and runs the pipeline as `advance` does (`claimJob`, `runJob` in `after()`, `maxDuration = 300`); the GET status route calls `jobStatus`, which applies the upload timeout; the job page's Retry and Skip call `retryJob` and `skipJob`, and its Skip also marks the ledger's application skipped. Extraction owns the conditional rows of the table: Skip at a role pick (`closed`, or back to `kit_ready` when another role has a kit) and "This is a job post" from `stopped` (only after a "not a job post" stop). Stages register in `src/server/pipeline.ts`; each stage's `input()` returns exactly what B9's table says it reads; enum fields of a model's answer use `caseless`, and nothing else in a stage schema changes a value (B4).
- [ ] **Task 10: Model wrapper** — Owns: platform AC11, AC12, AC13.
  - Streaming with idle timeout, one row per attempt, provisional costs, guard hook, retries, refusals, price table; the local-only check used by the dev server and the evaluation composition.
  - Code done: the wrapper, the price table and call log, the Claude and Gemini adapters (tested on recorded streams), the local-only check at server start and in the container, and the container's models (app keys in production, each loaded on first use; evaluation keys in development). The live contract tests wait for the owner's keys and go-ahead (docs/runbook/testing.md). The evaluation runner's own check is Task 20's; the test server's scripted models are Task 26's.
  - Verify: `npm test`; adapter contract tests in `--mode live`, with the owner's approval for a few cents. Depends on: 3. Files: src/core/platform/{models,prices}.ts, src/adapters/{anthropic,gemini,fake-llm}.ts, src/server/localOnly.ts. Scope: M.
- [x] **Task 11: Ledger core** — Owns: ledger AC1, AC2, AC3, AC7, AC8, AC10.
  - Normalisation, duplicate check with fuzzy post match, statuses and audit, arm assignment, trust-gate state, spend cap guard wired into the wrapper, CSV import.
  - Verify: `npm test`. Depends on: 3, 10. Files: src/core/ledger/{normalise,duplicates,statuses,arms,trustGate,spend}.ts, scripts/ledger-import.ts, db/migrations/NNNN_ledger.sql. Scope: M (two commits).
  - Done. For later tasks: intake calls `drawArm` once real use has started (AC4 and AC5 are Task 26's and the stats task's); the review module writes `draft_outcomes`, which `trustGateState` will read; every model stage takes `modelCallDeps(container)`, which carries the spend guard; the New job page asks `spendState`.
  - After three reviews: intake stores `drawArm`'s index on the job with its arm (a re-share draws again, a known trade-off the Stats page can show); extraction gives each role an ID (`P1`, …) and the role pick passes it to `openApplication`; the review page calls `setAddress` when the owner corrects the address and `setRoute` at the kit-type pick; the banner sends the keys of the matches it showed with `applyAgain`; CV label, profile version and final draft still need setters, written by the tasks that produce them; the job menu's correction is `undoStatus` with the last change it showed, and taking back Mark sent must also take back the draft outcome the review module wrote; the purge keeps `post_fingerprint`, which the duplicate check needs and which holds no personal data.
- [ ] **Task 12: Intake server path** — Owns: intake AC1, AC8, AC10.
  - Metadata-only job creation with arm assignment and `manual_run`, signed upload URLs, re-issue, confirm, 15-minute timeout, clock fields, upload-attempt log.
  - Verify: `npm test`. Depends on: 9, 11. Files: src/core/intake/{jobs,uploads}.ts, src/app/api/jobs/route.ts, src/app/api/jobs/[id]/{uploaded,upload-urls}/route.ts, db/migrations/NNNN_intake.sql. Scope: M.
- [ ] **Task 13: Intake client and share target** — Owns: intake AC2, AC3, AC4, AC5, AC6.
  - Encoding and tile counts, limits, resume, the New job page, the share-target page with the service worker's refusals and the server switch.
  - Verify: `npm test`; Playwright upload and synthetic-share tests. Depends on: 8, 12. Files: src/core/intake/{encode,tiles,limits}.ts, src/app/(app)/jobs/new/*, public/sw.js, e2e/upload.spec.ts. Scope: M.
- [ ] **Task 14: Profile** — Owns: profile AC1–AC7.
  - Schema, shared skill vocabulary and region table, seed with rollback (local by default, `--prod` for production), access API, Profile page, the public sample in CI. In parallel, the owner reviews `private/profile.yaml` (profile spec, "Drafting the first version"), approves facts and writes the rest; it is then seeded with `--prod`.
  - Code done: the schema and its line-numbered checks, the skill vocabulary and region table, the seed with rollback, the access API, the Profile page and the sample's checks. Claude drafts `private/profile.yaml`, which is never committed; the owner's review and the `--prod` seed are runbook step 13.
  - Draft done (2026-10-09): `private/profile.yaml` holds 30 facts, all `approved: false`, with sources and vocabulary tags, and `private/cv.pdf` is a copy of the portfolio's résumé. `npm run profile:seed` lists the 15 items left for the owner: the signature, the fixed answers' texts and 3 to 5 style examples.
  - Verify: `npm test`; `npm run profile:seed` on the sample profile locally. Depends on: 3. Files: src/core/profile/*, src/core/shared/{skills,regions}.ts, scripts/profile-seed.ts, src/app/(app)/profile/page.tsx. Scope: M.
- [ ] **Checkpoint B (day 5)** — a phone upload on the live site creates a job and stores its images; the spend cap guards every model call; the profile is seeded.

## Phase 2: Extraction and first measurement (days 5–9)

- [ ] **Task 15: Extraction core** — Owns: extraction AC1 (all but the oversized-image clause, which is Task 16's), AC3, AC5, AC8.
  - Record schema with sentinels (and the start of the schema-counting test), contact checks, phrase backstop, tiling and coordinate mapping. Tiles are neutral (image index, top offset, PNG bytes, width and height), with box mapping and the 30 MB request check.
  - In progress in parallel (2026-10-10): another session builds it test-first on `feat/extraction-core`, in the sibling worktree `../jobkit-extraction`, from 80af566. It touches only new files in src/core/extraction/ and new record fixtures in evals/synthetic/records/, and is merged here after its review.
  - Taken over (2026-10-12, the owner's choice): that session was deleted mid-task. Its uncommitted work is kept as found at a427544 on `feat/extraction-core` (contacts, record, schemas, tiles, tile geometry, 14 fixtures; unreviewed). This session reviews it and finishes Task 15 there, test first, after Task 9.
  - Verify: `npm test`. Depends on: 10, 14. Files: src/core/extraction/{record,contacts,backstop,tiles}.ts and tests. Scope: M.
- [ ] **Task 16: `extract`, stops, role pick, `extract_questions`** — Owns: extraction AC4, AC6, AC7, and AC1's clause that every image block carries `transformations: { oversized_image: "error" }` (the Llm port and the Claude adapter carry it; the SDK has the field on its beta Messages API only).
  - Verify: `npm test` with the fake model and synthetic fixtures. Depends on: 9, 12, 15. Files: src/core/extraction/{extractStage,questionsStage,prompts}.ts, src/app/api/jobs/[id]/role/route.ts. Scope: M.
- [ ] **Task 17: `address_read`** — Owns: extraction AC9, AC10, AC12.
  - Verify: `npm test` on synthetic images. Depends on: 16. Files: src/core/extraction/{crop,addressRead}.ts. Scope: S.
- [ ] **Task 18: `eligibility`** — Owns: extraction AC11.
  - Verify: `npm test` (table tests). Depends on: 14, 15. Files: src/core/extraction/eligibility.ts and tests. Scope: S.
- [ ] **Task 19: Evaluation tooling A** — Owns: evals AC1, AC2, AC7.
  - mbox and eml import, the labelling page (blind test labels first), `eval:pull`, the synthetic renderer.
  - Verify: `npm test`; the labelling page returns 404 in a production build. Depends on: 15, 16. Files: scripts/eval-import.ts, scripts/eval-pull.ts, src/app/dev/label/*, evals/render.ts. Scope: M.
- [ ] **Task 20: Evaluation tooling B** — Owns: evals AC3, AC4, AC5, AC6.
  - Split, scorer (exact match, Wilson, precision and recall, McNemar), runner with budget on the evaluation keys and a local database, reports and aggregate summary.
  - The runner calls `assertLocalOnly` (src/server/localOnly.ts) on both `process.env` and `loadLocalEnv()` before anything else (platform AC13), and takes its models from `modelsFor("development", …)`.
  - Before comparing models older than the 5.x family (Claude Haiku 4.5 in ADR entry 2), check the Claude adapter's request shape against them: it sends `output_config.effort` and no `thinking` parameter, which suits the 5.x models; an older one may reject the effort setting or need thinking set.
  - Verify: `npm test`. Depends on: 10, 19. Files: evals/{split,score,run,summary}.ts and tests. Scope: M.
- [ ] **Task 21: Live extraction evaluation** — Owns: none.
  - Runs on the dev split only, after the owner approves the estimated spend; records accuracy, per-stage latency and cost.
  - Verify: report reviewed by the owner. Depends on: 17, 18, 20, and the owner's labels. Files: private reports; a summary note in docs/runbook/measurements.md. Scope: S.
- [ ] **Checkpoint C (day 9)** — assumption 1 measured on dev cases; latency against the stage budget; owner review; doubt review.

## Phase 3: Drafting and the thin path (days 9–13)

- [ ] **Task 22: Drafting core and `validate`** — Owns: drafting AC4, AC5, AC6, AC7, AC8, AC10, AC12; extraction AC2.
  - Kit types and blocks, the keyword topic classifier, fixed answers, code-built subject, greeting and gap lines, the fit check, `validate(kit, context)` as a pure shared function; the schema-counting test extended to drafting's schemas.
  - Verify: `npm test`. Depends on: 14, 15. Files: src/core/drafting/{kit,topics,fit,gapLines,validate}.ts and tests. Scope: M (two commits).
- [ ] **Task 23: `draft`** — Owns: drafting AC1, AC2, AC3.
  - Verify: `npm test` with the fake model. Depends on: 9, 10, 22. Files: src/core/drafting/{draftStage,prompts}.ts. Scope: S.
- [ ] **Task 24: `judge`** — Owns: drafting AC9.
  - Verify: `npm test`. Depends on: 23. Files: src/core/drafting/judgeStage.ts and tests. Scope: S.
- [ ] **Task 25: `address_checks`** — Owns: review AC5.
  - DNS port and adapter, implicit and null MX, free mail, company mismatch.
  - Verify: `npm test` with a fake DNS. Depends on: 9. Files: src/core/review/addressChecks.ts, src/adapters/dns.ts. Scope: S.
- [ ] **Task 26: Thin kit page** — Owns: review AC1; ledger AC4; platform AC19.
  - Job page for email kits: progress, the manual-run screen with Stop, the contact panel with retype, flags with "I checked this", basic block editing with confirmation, `canHandOff` in the browser and on the server, polling rules; the jobs list.
  - First gives the test server scripted models, per stage, for the end-to-end tests (platform spec A3, B10): until then `modelsFor("test", …)` has none (src/server/models.ts).
  - Verify: `npm test`; Playwright with the fake models. Depends on: 11, 24, 25. Files: src/app/(app)/jobs/[id]/*, src/app/(app)/jobs/page.tsx, src/core/review/canHandOff.ts. Scope: M.
- [ ] **Task 27: Gmail handoff and Mark sent** — Owns: review AC3, AC7, AC10; ledger AC6.
  - The mechanism chosen in Task 8, built inside the click; Mark sent with the Gmail question; draft outcomes and factual edits; Skip.
  - Verify: `npm test`; Playwright with a slowed network. Depends on: 8, 26. Files: src/core/review/handoffs.ts, src/app/(app)/jobs/[id]/handoff/*, src/core/ledger/outcomes.ts. Scope: M.
- [ ] **Checkpoint D (day 13)** — a kit end to end from a real screenshot on the phone; production machine time; owner decision if the median misses 60 seconds; doubt review; real use starts at the next handoff.

## Phase 4: Full review, kits and stats (days 14–20)

- [ ] **Task 28: Job page in full** — Owns: review AC6, AC9, AC11.
  - Banners, every waiting and owner-state screen, the crop with full-screenshot fallback, the checklist with declines, the fit table with ticks, the scam override.
  - Verify: `npm test`; Playwright. Depends on: 26. Files: src/app/(app)/jobs/[id]/{banners,checklist,fit,contact}/*. Scope: M.
- [ ] **Task 29: Block editor and edit tracking** — Owns: review AC4; drafting AC13.
  - Add and delete blocks, mark a block as answering a requirement, topic choices, "Needs your line" and "Needs your answer", keep for evaluation.
  - Verify: `npm test`; Playwright. Depends on: 28. Files: src/app/(app)/jobs/[id]/editor/*, src/core/drafting/edits.ts. Scope: M.
- [ ] **Task 30: Form and message kits** — Owns: review AC2, AC8.
  - Copy controls, "Copy all", https-only application links, `wa.me`, Mark submitted; every outbound control behind the gate.
  - Verify: `npm test`; Playwright tries every control. Depends on: 27, 29. Files: src/app/(app)/jobs/[id]/{form,message}/*, src/core/review/links.ts. Scope: M.
- [ ] **Task 31: Adding screenshots and `draft_answers`** — Owns: intake AC11; drafting AC11.
  - Verify: `npm test`. Depends on: 13, 16, 24. Files: src/core/drafting/draftAnswersStage.ts, src/app/(app)/jobs/[id]/add/*. Scope: S.
- [ ] **Task 32: Evaluation part 2** — Owns: none (evals metrics for the judge).
  - The frozen judge set (Claude Code drafts candidates; the owner labels), judge metrics, gap coverage, the Opus–Sonnet comparison with McNemar; a live run on dev within budget.
  - Verify: report reviewed by the owner. Depends on: 20, 24. Files: evals/judgeSet.ts, private reports. Scope: M.
- [ ] **Task 33: Stats and Spend** — Owns: ledger AC5; intake AC12.
  - Verify: `npm test`. Depends on: 11, 27. Files: src/app/(app)/{stats,spend}/*, src/core/ledger/{stats,bootstrap}.ts. Scope: M.
- [ ] **Task 34: Retention purges** — Owns: intake AC7, AC9; ledger AC9.
  - Verify: `npm test` with a fake clock. Depends on: 11, 12, 13. Files: src/core/{intake,ledger}/purge.ts, src/app/api/cron/daily/route.ts. Scope: S.
- [ ] **Task 35: End-to-end and accessibility** — Owns: review AC12, AC13.
  - Verify: `npm run test:e2e`. Depends on: 30, 33. Files: e2e/flow.spec.ts, e2e/a11y.spec.ts. Scope: S.
- [ ] **Checkpoint E (day 20)** — all criteria owned so far pass; doubt review.

## Phase 5: Measure and write up (days 21–28)

- [ ] **Task 36: Final evaluation** — Owns: none.
  - The blind test split with `--final`; the aggregate summary approved by the owner.
  - Verify: summary approved. Depends on: 32 and real use. Files: evals/results/<date>.md. Scope: S.
- [ ] **Task 37: Write-up** — Owns: none.
  - README case study and Portfolio entry draft; full-history scan before anything is published.
  - Verify: the owner approves the text; the scan is clean. Depends on: 36. Files: README.md, a draft for Portfolio/src/data/projects.ts. Scope: S.
- [ ] **Checkpoint F (day 28)** — success criteria on the real uses so far; decide milestone 2 and whether to extend measuring.
