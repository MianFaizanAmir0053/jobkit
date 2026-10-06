# Implementation Plan: jobkit MVP

- **Status:** approved by the owner on 2026-10-06, after its review
- **Inputs:** [CAPABILITIES.md](../CAPABILITIES.md), the eight approved module specs (`SPEC-*.md`), [ADR 0001](../docs/decisions/0001-mvp-decisions.md)
- **Task list:** [tasks/todo.md](todo.md)

## Overview

Eight modules in the map's dependency order, built test-first over four weeks from Monday 2026-10-06 to Sunday 2026-11-02. The plan reaches a **thin end-to-end email path by the end of week 2**: share a screenshot, get an email kit checked by the judge, pass the outbound gate, hand off to Gmail, Mark sent. Real use starts at that first handoff, about 2026-10-19, so the comparison with the manual arm runs for two weeks. Week 3 completes the review page, the form and message kits, and the stats; week 4 measures and writes up, with two days of buffer. `send` waits for milestone 2.

**How much real use the measurement needs.** The owner applies to three or more jobs a day. The pooled comparison appears once each arm has 10 runs (ledger spec). With one new job in three assigned to the manual arm, that takes about 30 jobs: some 2 a day over the two weeks of real use. The first 20 tool uses alone take about 10 a week. If the owner applies less often, the numbers arrive later; at checkpoint F the owner decides whether to extend the measuring window.

## Calendar

| Week | Dates | Phases |
|---|---|---|
| 1 | Oct 6 – 12 | Phase 0 (foundation and spikes), Phase 1 (capture, ledger core, profile) |
| 2 | Oct 13 – 19 | Phase 2 (extraction, first measurement), Phase 3 (drafting and the thin path); real use starts |
| 3 | Oct 20 – 26 | Phase 4 (full review page, form and message kits, stats, purges) |
| 4 | Oct 27 – Nov 2 | Phase 5 (final evaluation, write-up), two days of buffer |

## Architecture decisions (from the specs)

- Ports and adapters: core logic is plain TypeScript; tests use PGlite, local storage and fake models, so no test touches the network.
- Own sign-in with `arctic` and a sessions table; QR pairing confirmed by a code typed on the laptop.
- Images go from the phone straight to Supabase Storage; functions see metadata only.
- A lease-based pipeline runner: one invocation runs as many stages as fit, resumed by polling pages, never by self-requests; stage outputs are reused by input hash.
- Claude Opus 5.5 for `extract`, `draft` and `judge`; Gemini Flash for the second read; evaluations on their own keys and a local database.
- Scripts work on the local database unless run with `--prod` and the owner's typed confirmation.
- Before writing any Next.js code, read the guides shipped in `node_modules/next/dist/docs/`: the owner's Portfolio project records that Next 16 changed APIs and conventions.

## Phases

### Phase 0: Foundation and spikes (days 1–3)
Tasks 1–8. Scaffold, guard and CI, database and storage layers, sign-in and sessions, pairing, the Baseline page, the deploy skeleton, and three early spikes on the owner's phone and on Vercel: the share target, the tap-count comparison of the two Gmail handoffs on a static page, and a 200-second `after()` run.
- **Checkpoint A (day 3):** tests green; sign-in, pairing and baseline timing work on the real laptop and phone; spike results recorded; doubt review of sessions and pairing; merge to `main`.

### Phase 1: Capture, ledger and profile (days 3–5)
Tasks 9–14. Runner, model wrapper, ledger core with the spend cap and arm assignment, intake, and the profile.
- **Checkpoint B (day 5):** a phone upload on the live site creates a job and stores its images; the runner advances fake stages in tests; the spend cap guards every model call; the owner has approved the profile.

### Phase 2: Extraction and first measurement (days 5–9)
Tasks 15–21. Extraction core and stages, eligibility, the evaluation tooling, and a live extraction run on the dev split.
- **Checkpoint C (day 9, gate before drafting):** assumption 1 measured on dev cases; per-stage latency against the budget; the owner reviews; doubt review. Test-split cases stay untouched until Task 36.

### Phase 3: Drafting and the thin path (days 9–13)
Tasks 22–27. Drafting core, `draft`, `judge`, `address_checks`, a minimal email-kit page with the outbound gate, the chosen Gmail handoff and Mark sent.
- **Checkpoint D (day 13):** a kit end to end from a real screenshot on the phone; machine time measured in production; if the median misses 60 seconds the owner decides (amendment A9); doubt review; **real use starts at the next handoff**.

### Phase 4: Full review, kits and stats (days 14–20)
Tasks 28–35. The full job page and block editor, form and message kits with their handoffs, adding screenshots to a job, `draft_answers`, judge evaluation, stats and spend, retention purges, end-to-end and accessibility tests.
- **Checkpoint E (day 20):** every spec criterion owned so far passes; doubt review.

### Phase 5: Measure and write up (days 21–28)
Tasks 36–37, then buffer.
- **Checkpoint F (day 28):** success criteria on the real uses so far; decide milestone 2 and whether to extend measuring.

## Ranked cut list

Only items still unbuilt when time runs short can be cut. In order, first to last:

1. The Sonnet comparison runs (latency and accuracy of Opus alone still inform checkpoint D).
2. Handoff mechanism B, if the week-1 spike did not already settle on it.
3. The company-mismatch warning.
4. The `wa.me` button (message kits stay copy-only).
5. The form-screenshot path (`extract_questions` and `draft_answers`); the owner answers added questions by hand.
6. The crop display (the full screenshot is shown; the second read still uses the crop).
7. The Stats page's comparison view (the numbers stay available from a script).

**Never cut:** the email kit with its Gmail handoff (ADR 0001 entry 13's floor), the claim check, the outbound gate, strict contact checks, the eligibility gate, the untrusted-input rules, the spend cap, ledger timing and statuses, retention, and the blind labelling of the test split (amendments A10 and A17; only the owner can change it).

## Effort

**Agent (Claude Code), working days of build time, including tests:**

| Phase | Days |
|---|---|
| 0 | 3 |
| 1 | 2 |
| 2 | 4 |
| 3 | 4 |
| 4 | 7 |
| 5 | 3, plus 2 of buffer |

**Owner, by week:**

| Week | What | About |
|---|---|---|
| 1 | Takeout export started; accounts and keys per [the runbook](../docs/runbook/setup.md); phone spikes and device tests at checkpoint A; approve profile facts and write fixed answers, templates and signature; pick style examples; Gmail mobile signature; earlier-applications CSV; time every manual application | 6 hours, plus the timing |
| 2 | Match screenshots to sent emails; blind-label the test cases, then label dev cases; checkpoint C review; day-3 cost review; checkpoint D device test | 5 hours |
| 3 | Real use (one new job in three manual); label the judge set; checkpoint E review | 2 hours, plus the applications |
| 4 | Real use; approve the evaluation summary and the write-up; checkpoint F | 2 hours, plus the applications |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Share target broken on Chrome 153 | Medium | Day-1 spike; upload button; server switch |
| Opus latency above 60 seconds median | High | Stage budgets; concurrent drafting group; measured at C and D; owner decides |
| Cost above estimate | Medium | Day-3 review; cap; lower effort or cheaper stage models on evidence |
| Address or number misread | High | Gemini second read on a crop; retype; strict checks |
| Takeout export late, or archive under 20 cases | Medium | Label synthetic and live cases first; checkpoint C proceeds with what exists |
| Long `after()` runs behave differently on Vercel | Medium | Day-2 spike with a 200-second run |
| Session or pairing bug | High | Test-first; live contract tests; doubt review at checkpoint A |
| Runner lease bug | Medium | Atomic claims; live race test; Retry and Skip |
| Too few applications to compare | Medium | Rate stated above; owner decides at F whether to extend |

## Working rules

- `main` is deployed. Task 7 merges the skeleton to `main` so the live site exists; after that, each phase works on a branch (`mvp/phase-<n>`) merged at its checkpoint. Vercel previews hold no secrets.
- One task per commit, Conventional Commits with the module id as scope.
- Each task starts with failing tests (test-driven-development skill) and ends with `npm run check` green; platform AC1 holds after every task.
- Jobs created by spikes, tests or device checks are marked as test jobs and never count as real use.
- A doubt review (fresh-context reviewer) runs at every checkpoint, with a cross-model offer; findings are folded in before the next phase.
- Any change to a rule in a spec goes into the spec first, with the owner's approval when it changes a decision.
