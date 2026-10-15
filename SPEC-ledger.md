# Spec: ledger

- **Module id:** `ledger` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `platform`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 7, 11, 17, 20, 24 and 30, the status default, and amendments A1, A7, A8, A9 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A; job states from platform B9
- **Status:** approved by the owner on 2026-10-06, after two review cycles

## Objective

Keep the truth about applications: what was applied for, by which route, when, at what cost and how fast. The ledger warns before a repeat application, enforces the monthly spend cap, runs the timing comparison with the manual baseline, and records the factual-edit rate and trust-gate counter that milestone 2 will need.

## Records

- `applications`: one per job and role, by the role's ID in the extraction (SPEC-extraction, `roles`), so two roles written alike stay apart. A row is created when a role is chosen (automatically for a single-role post, by the owner otherwise); choosing the same role again, after a new extraction, updates it while no kit has gone out. It holds company, role, normalised keys, address or number, route, status, the time of each status change, the matches the owner's "apply again" taps covered, CV label, profile version, the final draft, the timing arm, and whether the job is an evaluation or test job.
- `earlier_applications`: applications made before jobkit, imported from the owner's list.
- `status_changes`: an audit row for every status change, with time and session.
- `draft_outcomes`: one row per email kit handed off, with the list of changed sentences and fields, `changed_in_gmail` and which draft went (`gemini`, or a template's ID: the owner's own words, decisions A22; none before the templates), written by the review module in the same transaction as the move to `sent`; taking back a sent tap removes it.
- `baseline_runs`: the manual runs, each tied to the job that started it.
- `upload_attempts`: written by intake, read for the Stats page.

## Normalisation and keys

- **Company:** lower case; legal forms removed (Ltd, Limited, LLC, Inc, Corp, Pvt, (Pvt) Ltd, GmbH, BV, FZ-LLC, PLC, the Gulf's W.L.L., DMCC, PJSC and Est., a leading "M/s", and the like); then every character that is not a letter or digit removed. An empty company produces no company key.
- **Role:** lower case; common abbreviations expanded (sr to senior, jr to junior, eng to engineer, dev to developer, swe to software engineer, fe to front end, be to back end); work-mode words removed ("remote", "hybrid", "onsite"); from text in brackets, and from parts set apart by " - ", " | ", ", " or ": ", only seniority, level, discipline and skill words are kept, placed first, so "React Developer (Senior)", "React Developer - Senior" and "Senior React Developer" are one role while "(Lahore)", "- Remote" and "Urgent hiring:" go (a title none of whose parts names a role keeps them all); then every character that is not a letter or digit removed, so "Front-End", "Front End" and "Frontend" match. Seniority words stay, because "Senior Engineer" and "Engineer" are different roles.
- `company_role_hash`: the SHA-256 of normalised company, a bar, and normalised role; absent when the company is empty.
- **Post fingerprint:** the set of word trigrams from the role's requirement texts, after the same lower-casing and abbreviations, plus each line of one or two words whole, since a terse list names its stack there.

## Duplicate check (ADR 0001 entry 11)

`findDuplicates(candidate)` compares a new application with sent and submitted applications, applications opened before it with a kit that was never sent, manual baseline runs, and earlier applications. Company and role are compared by the current normalisation, whatever an older row stored. Every match needs the owner's "apply again" tap before any outbound action:

- `company-role`: the same company-role hash, which also catches reposts with new text;
- `address`: the same address or number, a number matching with or without its country code or trunk 0 ("+92 300 1234567" and "0300-1234567"). The banner names the earlier role, because a shared inbox often serves several roles;
- `post`: post fingerprints with a Jaccard similarity of at least 0.6 and at least 3 entries in common, which catches a repost under a reworded title such as "Sr. Front End Developer";
- `drafted`: a kit already exists for the same company-role hash and was never sent.

The banner shows each match with its reason and date. An "apply again" tap covers the matches its banner showed and no others: a match found later, from a new row or from the application's own corrected address, holds the application again, and so does a drafted kit that is later sent.

## Statuses

| From | To | Trigger |
|---|---|---|
| (none) | `open` | a role is chosen |
| `open` | `kit_ready` | the job reaches `kit_ready` |
| `open` | `skipped` | the owner skips before a kit exists (role pick, eligibility decision, kit-type pick) |
| `kit_ready` | `sent` | the owner taps "Mark sent" after a Gmail handoff |
| `kit_ready` | `sent` | jobkit sends the email from the owner's Gmail (decisions A20) |
| `kit_ready` | `submitted` | the owner taps "Mark submitted" (form and message routes) |
| `kit_ready` | `skipped` | the owner taps Skip |
| `sent` | `bounced` | the owner taps "Mark bounced" |

Any other transition is refused, and "Mark sent" needs the email route while "Mark submitted" needs a form or message route. The owner can correct a mistaken tap from the job's menu: the last tap is taken back, which writes an audit row like any other change, except a skip made before the kit, which closed the job, and the `sent` of an email jobkit sent, which went. That email's outcome records no change in Gmail, and its `kit_sends` row keeps Gmail's message and thread IDs. A second tap on the same button changes nothing, so a double tap cannot record twice.

## The timing comparison (amendment A8)

- **Periods.** Before real use, the Baseline page (which ships in the first week) times the owner's manual applications. **Real use** starts at the first handoff of a kit made by jobkit; from then until the end of week 4, the comparison runs.
- **Arms.** During real use, the server assigns each new job to the manual arm with probability one in three, from a seeded random sequence, at the moment the job is created. The owner cannot choose or swap arms; a post the owner does not want to apply for is skipped, which removes it from both arms.
- **Manual arm.** The job page says "This one is a manual run: apply the old way, then tap Stop", starts the stopwatch from the job's start time (intake's clock), and shows nothing else for that job: no extraction or draft runs. At Stop, the owner picks the route and types the company and role, which enter the duplicate log.
- **Tool arm.** Total time runs from the job's start to `sent` or `submitted`.
- Both arms therefore start at the same event: the share or upload reaching jobkit with the screenshots already taken.

## Timing and stats

- **Machine time** and **processing time** as defined in platform B9.
- The Stats page shows, for real jobs only (not evaluation or test jobs):
  - count, median and 90th percentile of machine and total time, pooled and per route;
  - each stage's median processing time;
  - the route mix;
  - upload success rate;
  - the factual-edit rate with its 95% Wilson interval, and the trust-gate counter.
- **The comparison** shows the median total time of each arm, pooled and per route, with bootstrap 95% intervals for each median and for their ratio. It appears per route once that route has at least 5 runs in each arm, and pooled once both arms have 10. Pre-real-use baseline runs are shown separately and never enter the ratio.

## Factual edits and the trust-gate counter

- An email handoff records `factual_edit = true` when the owner's in-app edits changed a claim sentence, the address, the subject, a company or role name, the greeting's name or a gap line, or when the owner answers "Yes" to "Did you change anything in Gmail?" at Mark sent.
- "I checked this" on a flagged sentence, with no edit, keeps the outcome clean and is counted separately as a judge false positive.
- `trustGateState()` reads email outcomes in time order and returns `{ unlocked, cleanStreak, needed }`: unlocked after 10 consecutive clean outcomes; once unlocked, a factual edit locks it again and 5 clean outcomes unlock it. Skipped jobs and form and message kits do not count. In the MVP nothing acts on it.
- The streak is a gate, not a measurement. The Stats page reports the factual-edit rate over all email outcomes with its interval, and says that a streak of ten can occur by chance even at a rate near one in four.

## Spend cap

- Month-to-date cost is the sum of the app's `model_calls.cost_usd` in the current UTC calendar month, the same way a provider's workspace limit counts. Evaluation runs use their own key and local database (platform B4) and never appear here.
- New jobs are refused when month-to-date cost is at least $25. The guard injected into the model wrapper refuses any call once it reaches $26, so a job already running can finish but overshoot stays bounded. A warning banner shows from $20. Calls with unknown cost are counted at the most expensive known rate.
- The Spend page shows month-to-date cost, the median cost per job, and cost per stage. On day 3 of real use the owner reviews the measured cost per job and decides whether to change the cap or move a stage to a cheaper model (amendment A9).

## Retention (amendment A7)

The daily purge deletes extracted records, drafts and recruiter names 180 days after an application's last status change, and 30 days after the last state change for jobs that never got an application (`stopped`, `closed` before a role, `failed`, `upload_failed`). The application row keeps company, role, route, dates, status and the address or number, for duplicate checks.

## Earlier applications

`npm run ledger:import private/earlier.csv` reads rows of `company, role, applied_on, route, address` (address optional), validates each row, reports errors by line, and inserts rows keyed on company-role hash and date, so running it twice adds nothing; a row already there is corrected in place. With `--replace`, the stored rows the file no longer has are removed too, so the stored list becomes the file; an empty file is refused.

## Acceptance criteria

1. Table-driven tests cover normalisation: legal suffixes, abbreviations, location words, "Front-End" equal to "Front End" and "Frontend", kept seniority, and no company key for an empty company.
2. Duplicates: a repost with new text but the same company and role matches `company-role`; the same address under another role matches `address` and names that role; "Sr. Front End Developer" with mostly the same requirements matches `post`; a second share of a drafted post matches `drafted`; a manual run and an imported earlier application both match; every match needs "apply again".
3. Only the transitions in the table are accepted; a skip before a kit moves `open` to `skipped`; each change writes an audit row; a double tap records once.
4. With a seeded sequence, about one job in three is assigned to the manual arm; the arm cannot be changed; a manual-arm job runs no model stage; Stop records route, company and role.
5. Real use starts at the first kit handoff; pre-real-use baseline runs are reported apart and never enter the ratio; the comparison appears only past the thresholds above, with bootstrap intervals.
6. Factual-edit tests: an edited claim, address, subject, company or role name, greeting name or gap line each set `factual_edit`; a "Yes" to the Gmail question sets it; "I checked this" without an edit does not, and counts as a judge false positive.
7. Trust-gate sequence tests: 10 clean outcomes unlock; a factual edit after unlocking locks; 5 clean outcomes unlock again; skipped jobs and non-email kits are ignored.
8. With fixture `model_calls` rows, new jobs are refused from $25, calls are refused from $26, the banner shows from $20, and an unknown-cost call counts at the highest rate.
9. With a fake clock, the purge removes records, drafts and recruiter names after 180 days for applications and after 30 days for kit-less jobs, and keeps the application row.
10. The CSV import reports bad rows by line and is idempotent.
