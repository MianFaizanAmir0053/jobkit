# Spec: evals

- **Module id:** `evals` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `extraction`, `drafting`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 2, 3, 4, 9, 27 and 30, the one-pager's key assumptions, and amendments A7, A9 and A10
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** approved by the owner on 2026-10-06, after two review cycles

## Objective

Measure, on the owner's real past applications and on public synthetic cases, whether extraction reads posts correctly and whether the claim check catches what it should, and report the results honestly enough for a portfolio write-up. Everything runs on the laptop, with the separate "jobkit-evals" key and a local PGlite database (platform B4). Real data stays in `private/`, except what a run sends to the model providers' paid APIs. Only aggregates are published, after the owner approves them.

Production timing and cost come from the ledger's Stats and Spend pages, not from here: an evaluation run on the laptop skips upload, polling and cold starts, so its stage times are diagnostic only.

## Case sources

1. **Owner's archive (private).** Each case is a folder `private/archive/<case id>/` with the post's screenshots and, when one exists, the email the owner sent. Two ways to collect sent emails:
   - **Google Takeout (preferred; start on day 1, because an export can take hours or days):** the owner exports Gmail's Sent label as an mbox file. `npm run eval:import -- --mbox <file>` keeps messages Gmail labels Sent with `resume.pdf` attached (any case of the name; `--attachment` names another) and creates one case folder per message, `private/archive/<sent date>-<hash of its message ID>/email.eml`, so importing again adds only new ones. It leaves out mail sent from the day jobkit began drafting, whose words may be a model's: the first import takes its own time as that day and the archive keeps it (`import.json`); `--jobkit-from <YYYY-MM-DD>` gives the day instead.
   - **By hand:** in Gmail on the web, search `in:sent has:attachment filename:resume.pdf`, use "Download message" for each, put the `.eml` files in one folder, and run `npm run eval:import -- --eml <folder>`, which applies the same rules but Gmail's label, since a downloaded message has none. The labelling page names any folder or file at the archive's top that is not a case.
   
   The owner copies the matching screenshots from the phone into each folder. The labelling page lists each sent email beside screenshots taken within three days before it, to make matching quick; a phone names a screenshot by its local time.
2. **Live cases.** Any real job can be marked "keep for evaluation" on its job page. `npm run eval:pull` (`-- --prod` for the live site, after the project reference is typed) copies it into a case folder, `private/archive/live-<received date>-<job ID start>/`, with each image checked against its hash, the crop of its contact the second read stored (`crop.png`), its pasted text (`pasted.txt`), and the job's ID in `source.json`. A new case is put together aside and moved in whole, and only then are the copied images' keep flags cleared (intake spec). A job whose image cannot be copied stays kept for the next pull, or until `npm run eval:pull -- --release <job ID>` leaves it to the purge. This is how form and message routes enter the set, since sent mail holds only email applications.
3. **Synthetic cases (public).** About 12 fictional posts in `evals/synthetic/`, rendered to phone-sized screenshots by a script, the same bytes on every run with the same Chrome, including one tall scrolling screenshot: `npm run eval:render` lays each out as a feed post in the installed Chrome at 360 CSS pixels and three device pixels to each, into `evals/synthetic/screenshots/`, which git does not keep. A post too long for its height is refused, never cut off. The installed Chrome updates itself, so each run records Chrome's version and each image's hash in `manifest.json` beside the images and names any image that changed since the last run; evaluation reports record the manifest, so runs on different renders are never compared unawares. They cover every route and kit shape, a post with several roles, a non-English post, a post and a form question addressed to AI, a scam post, a post whose contact has no country code, and inflation traps such as "10+ years leading Kubernetes platforms". CI uses them with recorded model outputs; live runs score them as the model-behaviour criteria the extraction and drafting specs defer here.

**Exclusion:** a case whose sent email matches one of the profile's style examples (its body, with case and spacing normalised, holds the example's text) is excluded, so the drafter is never scored on an email it was shown as a model (amendment A10). The import leaves such mail out when the profile's examples can be read, and the labelling page, `npm run eval:split` and the runner check every case again, so an example chosen after the import still excludes its case.

## Labelling

- A labelling page, `/dev/label`, exists only when `JOBKIT_ENV=development` and `JOBKIT_LOCAL_EVALS=1`, and only for the laptop's own session. It reads and writes the case folders through the file system. In a production build the route returns 404: its files are local-only, so no build has them, and the build check fails any build with a route under `/dev/`. Screenshots not yet matched wait in `private/archive/_screenshots/`; a phone's file name gives the time one was taken, else the file's time. Each case's split is kept in `private/archive/split.json`, written whole; a split file that cannot be read stops the page and the scripts rather than assigning the cases again.
- For each case the owner records company, role, route, the exact address or number, the eligibility outcome, the must-have requirements, and, for a case with a crop, whether the crop shows the whole address or number. Nothing starts chosen. They save it as `labels.json`.
- **Blind test split (amendment A10):** the ten `test` cases are labelled first, from scratch, with no pre-labels shown. Their pre-labels are produced afterwards and kept hidden, so the headline numbers rest on labels no model shaped.
- **Dev cases** are labelled with pre-labels shown (`npm run eval:prelabel`, after a cost estimate and `--yes`), to save time. The write-up reports how often the owner corrected pre-labels on dev, and how often hidden pre-labels disagreed with blind labels on test, and says that the two sets are different cases.
- **Frozen judge set:** Claude Code drafts candidate sentences against the real profile's facts, at least 40 overstated or unsupported (inflated years, scale, depth, seniority, "led", invented skills) and at least 40 supported. The owner labels each once, blind to any verdict. The set lives in `private/evals/judge-set.json` and never changes, so judge results stay comparable across prompt and model changes.
- **Owner time:** about 2 to 3 hours for case labels, 40 minutes for the judge set, and 30 minutes for matching screenshots, spread over weeks 1 and 2.

## Splits

`npm run eval:split` assigns each case once; viewing the labelling page never does. The owner runs it after adding the screenshots of the cases they mean to keep and deleting the folders that are not applications, and again when new cases are ready. Only a case ready to label gets a split: one with screenshots, whose files can be read, and not excluded. Cases without one are taken in the order of their IDs' hashes, to `test` while it holds fewer than 10 ready cases, the rest to `dev`. A test case deleted or excluded later frees its place for a later case. Cases that seem one application, a resend with the same subject and words or a reply in its thread, share one split, in `test` only when all of them fit, and the page flags them so the owner can delete the extras. A case without a split shows no pre-labels, and the runner uses only cases with one. Live cases arrive after the split is fixed, so form and message routes are measured on `dev` unless kept jobs are pulled first. The runner prints per-case details only for `dev`. `test` cases are scored only with `--final`, which records that a final run happened. Prompts are tuned on `dev` alone.

## Metrics

- **Extraction:** per-field accuracy for company, role and route (company and role after the ledger's normalisation), exact match for the address or number (an address without case or surrounding space; a number as the number jobkit would message, or by its digits when its country code cannot be read, since jobkit never guesses one), and agreement on the eligibility outcome, each with its count and a Wilson 95% interval, pooled and per route.
- **Second read:** how often the Gemini read agreed with the labelled contact, how often it caught an Opus misread, and how often it raised a false alarm.
- **Crop:** the share of email and WhatsApp cases whose crop the owner ticked as showing the contact.
- **Judge:** recall and precision for "not supported" on the frozen judge set, with intervals, and separately on claim sentences from live drafts.
- **Gap coverage:** the share of labelled must-have gaps that the draft answers with a gap line.
- **Model comparison:** Claude Opus 5.5 against Claude Sonnet 5.5 for each Claude stage on the same cases, with an exact McNemar test on the cases where exactly one model was right. A difference the test does not support is reported as "no difference shown", never as "equal".
- **Diagnostics:** stage times and cost per case from the runs.

Pass marks are the one-pager's assumptions, read as point estimates and always printed with their intervals and counts. The write-up says plainly what a set of this size cannot show; for example, 30 correct out of 30 still leaves a 95% lower bound of about 89%, and 10 out of 10 about 72%.

## Runs, budget and reports

- `npm run eval -- --stage <extract|address_read|draft|judge|judge-set|all> --model <id> [--split dev|test --final] [--yes] [--budget <usd>]` prints the estimated cost and the case count, spends only with `--yes`, and stops when the run passes its budget (default $5). It refuses to start without `ANTHROPIC_EVALS_API_KEY`. The estimate is the most the cases can cost: each screenshot tile at its highest token count, each answer at its limit. The budget is kept by refusing any model call that could take the run past it; a case that meets the budget is not scored. The run goes through the app's own stages and runner, and at a post with several roles goes on with the labelled one. A run on `test` without `--final` is refused, and each final run is recorded in `private/evals/final-runs.json`.
- **Monthly plan within the $15 evaluation workspace:** pre-labels about $3; one Opus pass of draft and judge on dev about $5; the judge set about $1; the Sonnet comparison on dev about $3; the final test run about $2: about $14 in all. The runner shows the month's evaluation spend so far; the owner can raise the workspace limit if a run needs it.
- Each run writes `private/evals/runs/<timestamp>-<stage>-<model>/` with `report.json` and `report.md`, holding per-case outputs and scores, the git commit, and the model and prompt versions.
- `npm run eval:summary` writes an aggregate-only summary: metrics, intervals, counts, cost and timing, with no case content, names, companies, addresses or numbers. It goes to `evals/results/<date>.md` only after the owner approves it.
- Any example quoted in the write-up is anonymised first, with company, people, addresses, numbers and links replaced by placeholders (following mailagent's `app/eval/anonymize.py`), and the owner approves the text.

## Acceptance criteria

1. The mbox import keeps only Sent messages with `resume.pdf` attached and creates one case per message; malformed messages are reported, not fatal; a case matching a style example is excluded.
2. In a production build, `/dev/label` returns 404 (tested).
3. The split is deterministic; `test` cases never show pre-labels before their labels are saved; the runner refuses to print `test` details without `--final`; judge-set and claim labelling never show a verdict.
4. Scorer unit tests on fixed inputs: exact match after normalisation; Wilson intervals for 30 of 30 and 10 of 10 match known values; precision and recall on a small labelled table; the exact McNemar p-value on a known table.
5. Without `--yes` a live run spends nothing; with it, the run stops at its budget; no run starts without the evaluation key or writes outside its local database.
6. The aggregate summary contains no case text, no company or person names, and no addresses or numbers (checked by a test that plants such strings in fixture runs).
7. The synthetic screenshots render identically on every run, and CI's regression tests pass with recorded outputs and no network.
