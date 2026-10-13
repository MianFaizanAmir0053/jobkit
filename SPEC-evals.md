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
   - **Google Takeout (preferred; start on day 1, because an export can take hours or days):** the owner exports Gmail's Sent label as an mbox file. `npm run eval:import -- --mbox <file>` keeps messages Gmail labels Sent with `resume.pdf` attached (any case of the name; `--attachment` names another) and creates one case folder per message, `private/archive/<sent date>-<hash of its message ID>/email.eml`, so importing again adds only new ones.
   - **By hand:** in Gmail on the web, search `in:sent has:attachment filename:resume.pdf`, use "Download message" for each, and drop the `.eml` files into case folders.
   
   The owner copies the matching screenshots from the phone into each folder. The labelling page lists each sent email beside screenshots taken within three days before it, to make matching quick.
2. **Live cases.** Any real job can be marked "keep for evaluation" on its job page. `npm run eval:pull` (`-- --prod` for the live site, after the project reference is typed) copies it into a case folder, `private/archive/live-<received date>-<job ID start>/` with each image checked against its hash and the job's ID in `source.json`, and only then clears the cloud copy's keep flag (intake spec); a job whose image cannot be copied stays kept for the next pull. This is how form and message routes enter the set, since sent mail holds only email applications.
3. **Synthetic cases (public).** About 12 fictional posts in `evals/synthetic/`, rendered to phone-sized screenshots by a script, deterministically, including one tall scrolling screenshot: `npm run eval:render` lays each out as a feed post in the installed Chrome at 360 CSS pixels and three device pixels to each, into `evals/synthetic/screenshots/`, which git does not keep. They cover every route and kit shape, a post with several roles, a non-English post, a post and a form question addressed to AI, a scam post, a post whose contact has no country code, and inflation traps such as "10+ years leading Kubernetes platforms". CI uses them with recorded model outputs; live runs score them as the model-behaviour criteria the extraction and drafting specs defer here.

**Exclusion:** a case whose sent email matches one of the profile's style examples (its body, with case and spacing normalised, holds the example's text) is excluded, so the drafter is never scored on an email it was shown as a model (amendment A10).

## Labelling

- A labelling page, `/dev/label`, exists only when `JOBKIT_ENV=development` and `JOBKIT_LOCAL_EVALS=1`. It reads and writes the case folders through the file system. In a production build the route returns 404.
- For each case the owner records company, role, route, the exact address or number, the eligibility outcome, the must-have requirements, and whether the stored crop shows the address or number. They save it as `labels.json`.
- **Blind test split (amendment A10):** the ten `test` cases are labelled first, from scratch, with no pre-labels shown. Their pre-labels are produced afterwards and kept hidden, so the headline numbers rest on labels no model shaped.
- **Dev cases** are labelled with pre-labels shown (`npm run eval:prelabel`, after a cost estimate and `--yes`), to save time. The write-up reports how often the owner corrected pre-labels on dev, and how often hidden pre-labels disagreed with blind labels on test, and says that the two sets are different cases.
- **Frozen judge set:** Claude Code drafts candidate sentences against the real profile's facts, at least 40 overstated or unsupported (inflated years, scale, depth, seniority, "led", invented skills) and at least 40 supported. The owner labels each once, blind to any verdict. The set lives in `private/evals/judge-set.json` and never changes, so judge results stay comparable across prompt and model changes.
- **Owner time:** about 2 to 3 hours for case labels, 40 minutes for the judge set, and 30 minutes for matching screenshots, spread over weeks 1 and 2.

## Splits

Each case is assigned once, by a hash of its ID: 10 cases to `test`, the rest to `dev`. The runner prints per-case details only for `dev`. `test` cases are scored only with `--final`, which records that a final run happened. Prompts are tuned on `dev` alone.

## Metrics

- **Extraction:** per-field accuracy for company, role and route (after normalisation), exact match for the address or number, and agreement on the eligibility outcome, each with its count and a Wilson 95% interval, pooled and per route.
- **Second read:** how often the Gemini read agreed with the labelled contact, how often it caught an Opus misread, and how often it raised a false alarm.
- **Crop:** the share of email and WhatsApp cases whose crop the owner ticked as showing the contact.
- **Judge:** recall and precision for "not supported" on the frozen judge set, with intervals, and separately on claim sentences from live drafts.
- **Gap coverage:** the share of labelled must-have gaps that the draft answers with a gap line.
- **Model comparison:** Claude Opus 5.5 against Claude Sonnet 5.5 for each Claude stage on the same cases, with an exact McNemar test on the cases where exactly one model was right. A difference the test does not support is reported as "no difference shown", never as "equal".
- **Diagnostics:** stage times and cost per case from the runs.

Pass marks are the one-pager's assumptions, read as point estimates and always printed with their intervals and counts. The write-up says plainly what a set of this size cannot show; for example, 30 correct out of 30 still leaves a 95% lower bound of about 89%, and 10 out of 10 about 72%.

## Runs, budget and reports

- `npm run eval -- --stage <extract|address_read|draft|judge|judge-set|all> --model <id> [--split dev|test --final] [--yes] [--budget <usd>]` prints the estimated cost and the case count, spends only with `--yes`, and stops when the run passes its budget (default $5). It refuses to start without `ANTHROPIC_EVALS_API_KEY`.
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
