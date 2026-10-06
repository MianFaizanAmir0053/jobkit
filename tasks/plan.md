# Implementation Plan: jobkit MVP

- **Status:** draft for owner approval
- **Inputs:** [CAPABILITIES.md](../CAPABILITIES.md), the eight approved module specs (`SPEC-*.md`), [ADR 0001](../docs/decisions/0001-mvp-decisions.md)
- **Task list:** [tasks/todo.md](todo.md)

## Overview

Eight modules, built in the map's dependency order as vertical slices, over four weeks from 2026-10-06. Every task is test-first. Real use starts at the first handoff of a kit, planned for the start of week 3; the comparison with the manual arm runs from then to the end of week 4, when the first 20 real uses are measured and written up. `send` waits for milestone 2.

## Architecture decisions (from the specs)

- Ports and adapters: core logic is plain TypeScript; tests use PGlite, local storage and fake models, so no test touches the network.
- Own sign-in with `arctic` and a sessions table; QR pairing confirmed by a code typed on the laptop.
- Images go from the phone straight to Supabase Storage; functions see metadata only.
- A lease-based pipeline runner: one invocation runs as many stages as fit, resumed by polling pages, never by self-requests; stage outputs are reused by input hash.
- Claude Opus 5.5 for `extract`, `draft` and `judge`; Gemini Flash for the second read; evaluations on their own keys and local database.
- Before writing any Next.js code, read the guides shipped in `node_modules/next/dist/docs/`: the owner's Portfolio project records that Next 16 changed APIs and conventions.

## Phases

### Phase 0: Foundation (days 1-2)
1. Scaffold and tooling.
2. Guard and CI.
3. Database layer and bootstrap.
4. Google sign-in and sessions.
5. QR pairing.
6. Baseline page and Stats shell, so manual applications are timed from week 1.
7. Deploy skeleton on Vercel and Supabase; keep-alive; sign-in and pairing on the real laptop and phone.
- **Checkpoint A:** tests green; sign-in, pairing and baseline timing work on real devices. Doubt review of sessions and pairing.

### Phase 1: Capture (days 2-4)
8. Phone spike: PWA install, share target, refusals, server switch.
9. Intake upload path.
10. Runner: states, kinds, pending stage, leases, stage hashes, state history, polling rules.
11. Model wrapper.
12. Profile, with the shared skill vocabulary and region table. (Owner, in parallel: approve the drafted facts.)
- **Checkpoint B:** a phone upload creates a job, and fake stages advance through the state table.

### Phase 2: Extraction and first measurement (day 4 to week 2, day 2)
13. Extraction core.
14. `extract`, stops and override, role pick, `extract_questions`.
15. `address_read`.
16. `eligibility`.
17. Evaluations, part 1.
18. Live extraction evaluation; stage latency and cost measured.
- **Checkpoint C (gate before drafting):** assumption 1 measured; per-stage latency against the budget; the owner reviews. Doubt review.

### Phase 3: Drafting (week 2)
19. Drafting core and `validate`.
20. `draft` and `draft_answers`.
21. `judge`.
22. Evaluations, part 2.
- **Checkpoint D:** a kit end to end from a real screenshot; machine time measured in production; if the median misses 60 seconds, the owner decides (amendment A9). Doubt review.

### Phase 4: Review and ledger (week 3)
23. Ledger core.
24. `address_checks`.
25. Job page, part 1.
26. Job page, part 2.
27. Handoffs, and the tap-count spike.
28. Stats and Spend.
29. Retention purges.
30. End-to-end flow and accessibility.
- **Checkpoint E:** real use starts at the first handoff. Doubt review.

### Phase 5: Measure and write up (week 4)
31. Final evaluation on the blind test split.
32. Write-up: README case study and Portfolio entry draft.
- **Checkpoint F:** success criteria on the first 20 real uses; decide milestone 2.

## Ranked cut list

If time runs short, drop in this order, first to last:

1. Share target (the upload button stays).
2. Sonnet comparison runs.
3. Handoff mechanism B.
4. Company-mismatch warning.
5. Crop display (the full screenshot is shown; the second read still uses the crop).
6. Blind labelling of the test split (the write-up states the limitation).
7. QR pairing (the phone signs in with Google).
8. `wa.me` link (copy only).

Never cut: the claim check, the outbound gate, strict contact checks, the eligibility gate, the untrusted-input rules, the spend cap, ledger timing and statuses, and retention.

## Owner tasks and time

| When | What | Time |
|---|---|---|
| Day 1 | Start the Takeout export; accounts and keys per [the runbook](../docs/runbook/setup.md); Gmail mobile signature | about 1.5 hours |
| Days 1-3 | Approve profile facts and phrases; write templates, fixed answers and signature; pick style examples | about 2 hours |
| Week 1 | Phone spike; type the earlier-applications CSV; time every manual application on the Baseline page | about 30 minutes, plus the timing |
| Weeks 1-2 | Match screenshots to sent emails; blind-label the test cases first; label dev cases; label the judge set | about 3.5 hours |
| Checkpoints | Review numbers and decide (C, D, F) | about 30 minutes each |
| Weeks 3-4 | Real use; one new job in three is a manual run | as jobs arrive |
| Week 4 | Approve the write-up | about 30 minutes |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Share target broken on Chrome 153 | Medium | Upload button; day-1 spike; server switch |
| Opus latency above 60 seconds median | High | Stage budgets; concurrent drafting group; measured at C and D; owner decides |
| Cost above estimate | Medium | Day-3 review; cap; caching only if measured to help |
| Address or number misread | High | Gemini second read on a crop; retype; strict checks |
| Archive under 20 cases | Medium | Live cases; synthetic set |
| Session or pairing bug | High | Test-first; live contract tests; doubt review at checkpoint A |
| Runner lease bug | Medium | Atomic claims; live race test; Retry and Skip |
| Owner time | Medium | Budgeted above; labelling spread over two weeks |

## Working rules

- One task per commit, Conventional Commits with the module id as scope, on branch `mvp/build`, merged to `main` at each checkpoint.
- Each task starts with failing tests (test-driven-development skill) and ends with `npm run check` green.
- A doubt review (fresh-context reviewer) runs at every checkpoint, with a cross-model offer; findings are folded in before the next phase.
- Any change to a rule in a spec goes into the spec first, with the owner's approval when it changes a decision.
