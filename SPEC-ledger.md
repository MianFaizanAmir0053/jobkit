# Spec: ledger

- **Module id:** `ledger` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `platform`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 7, 11, 17, 20 and 24, the status default, and amendments A1, A7, A8, A9 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** draft for owner approval

## Objective

Keep the truth about applications: what was applied for, by which route, when, at what cost and how fast. The ledger warns before a repeat application, enforces the monthly spend cap, times the interleaved manual baseline, and records the factual-edit rate and trust-gate counter that milestone 2 will need.

## Records

- `applications`, one per job that reached a kit: company, role, normalised keys, address or number, route, status, the time of each status change, CV label, profile version, the final draft, and whether the job is an evaluation or test job.
- `earlier_applications`: applications made before jobkit, imported from the owner's list.
- `status_changes`: an audit row for every status change, with time and session.
- `draft_outcomes`: one row per email kit handed off, with `factual_edit` and `changed_in_gmail`, written by the review module.
- `baseline_runs`: the manual stopwatch runs.

## Normalisation and keys

- **Company:** lower case; punctuation removed; legal suffixes removed (Ltd, Limited, LLC, Inc, Corp, Pvt, (Pvt) Ltd, GmbH, BV, FZ-LLC, PLC and the like); whitespace collapsed.
- **Role:** lower case; punctuation removed; common abbreviations expanded (sr to senior, jr to junior, eng to engineer, dev to developer, swe to software engineer); location and work-mode suffixes removed ("- Remote", "(Lahore)", "Hybrid"); seniority words kept, because "Senior Engineer" and "Engineer" are different roles.
- `company_role_hash` is the SHA-256 of normalised company, a bar, and normalised role.

## Duplicate check

`findDuplicates(candidate)` compares a new job with sent and submitted applications, earlier applications, and jobs that already have a kit. It returns every match with its reason and date:

- `company-role`: same company and role, which also catches reposts with new text. **Needs "apply again".**
- `drafted`: a kit already exists for the same company and role and was never sent. **Needs "apply again".**
- `address`: same address or number under another role. **Information only**, because one inbox often serves every role at a company.

The review page shows every match; the handoff gate (review spec) enforces the "apply again" tap.

## Statuses

| From | To | Trigger |
|---|---|---|
| (none) | `kit_ready` | a kit is ready |
| `kit_ready` | `sent` | the owner taps "Mark sent" after a Gmail handoff |
| `kit_ready` | `submitted` | the owner taps "Mark submitted" (form and message routes) |
| `kit_ready` | `skipped` | the owner taps Skip, or skips on the eligibility banner |
| `sent` | `bounced` | the owner taps "Mark bounced" |

Any other transition is refused. The owner can correct a mistaken tap from the job's menu, which writes an audit row like any other change.

## Timing and stats

- **Machine time:** the sum of the job's stage durations (platform B9), which leaves out time spent waiting for the owner.
- **Total time:** from the job's start (intake's clock) to `sent` or `submitted`.
- The Stats page shows, for real jobs only (not evaluation or test jobs), the count, median and 90th percentile of both times, pooled and per route; each stage's median; the route mix; the factual-edit rate; and the trust-gate counter.

## Interleaved baseline (amendment A8)

- During weeks 1 to 3, every third application is done the old manual way. The New job page says when the next one is due ("This one is a manual run"), and the owner can swap it with the next job if this post does not suit.
- The Baseline page has Start and Stop, a route picker and a note. The owner taps Start at the same moment the tool's clock would start (post in hand, nothing opened yet) and Stop when the application is sent or submitted.
- The Stats page shows the baseline's count, median and 90th percentile, pooled and per route. "N times faster" appears only per route with at least 5 baseline runs and 5 tool applications on that route, and pooled once both arms have 10.

## Factual edits and the trust-gate counter

- An email handoff records `factual_edit = true` when the owner's in-app edits changed a claim sentence, the address, the subject, a company or role name, the greeting's name, or a gap line, or when the owner answers "Yes" to "Did you change anything in Gmail?" at Mark sent.
- "I checked this" on a flagged sentence, with no edit, keeps the outcome clean and is counted separately as a judge false positive.
- `trustGateState()` reads email outcomes in time order and returns `{ unlocked, cleanStreak, needed }`: unlocked after 10 consecutive clean outcomes; once unlocked, a factual edit locks it again and 5 clean outcomes unlock it. Skipped jobs and form and message kits do not count. In the MVP the state is shown on the Stats page only; nothing acts on it.
- The Stats page states the limit of the evidence: ten clean drafts in a row are still consistent with a factual-edit rate of up to about 26% (95% upper bound).

## Spend cap

- Month-to-date cost is the sum of the app's `model_calls.cost_usd` in the current UTC calendar month, matching how Anthropic's workspace limit counts. Evaluation runs use the separate "jobkit-evals" key and never write to the production database.
- New jobs are refused when month-to-date cost is at least $25. The guard injected into the model wrapper refuses any call once it reaches $26, so a job already running can finish but overshoot stays bounded. A warning banner shows from $20.
- The Spend page shows month-to-date cost, the median cost per job, and cost per stage. On day 3 of real use the owner reviews the measured cost per job and decides whether to change the cap or move a stage to a cheaper model (amendment A9).

## Retention (amendment A7)

The daily purge deletes extracted records, drafts and recruiter names 180 days after the job's last status change. The application row keeps company, role, route, dates, status and the address or number, for duplicate checks.

## Earlier applications

`npm run ledger:import private/earlier.csv` reads rows of `company, role, applied_on, route, address` (address optional), validates each row, reports errors by line, and inserts rows keyed on company-role hash and date, so running it twice adds nothing.

## Acceptance criteria

1. Table-driven tests cover company and role normalisation: legal suffixes, abbreviations, location suffixes, and kept seniority.
2. A repost with new text but the same company and role matches `company-role` with the earlier date; a second share of a drafted post matches `drafted`; the same address under another role yields an information-only `address` match; an imported earlier application matches.
3. Only the transitions in the table are accepted, and each writes an audit row with time and session.
4. Machine time is the sum of stage durations and excludes waiting states; total time runs from intake's start; stats exclude evaluation and test jobs and report n, median and 90th percentile, pooled and per route.
5. Every third application in weeks 1 to 3 is announced as a manual run; the comparison appears only once the thresholds above are met.
6. Factual-edit tests: an edited claim, address, subject, company or role name, greeting name or gap line each set `factual_edit`; a "Yes" to the Gmail question sets it; "I checked this" without an edit does not, and is counted as a judge false positive.
7. Trust-gate sequence tests: 10 clean outcomes unlock; a factual edit after unlocking locks; 5 clean outcomes unlock again; skipped jobs and non-email kits are ignored.
8. With fixture `model_calls` rows, new jobs are refused from $25, calls are refused from $26, and the banner shows from $20.
9. With a fake clock, the purge removes records, drafts and recruiter names after 180 days and keeps the application row.
10. The CSV import reports bad rows by line and is idempotent.
