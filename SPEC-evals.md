# Spec: evals

- **Module id:** `evals` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `extraction`, `drafting`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 2, 3, 4, 9, 27 and 30, the one-pager's key assumptions, and amendments A7, A9 and A10
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** draft for owner approval

## Objective

Measure, on the owner's real past applications and on public synthetic cases, whether extraction reads posts correctly and whether the claim check catches what it should, and report the results honestly enough for a portfolio write-up. Everything runs on the laptop with the separate "jobkit-evals" key. Real data stays in `private/`, except what an evaluation run sends to the model providers' paid APIs. Only aggregates are published, after the owner approves them.

## Case sources

1. **Owner's archive (private).** Each case is a folder `private/archive/<case id>/` with the post's screenshots and, when one exists, the email the owner sent. Two ways to collect sent emails:
   - **Google Takeout (preferred):** the owner exports Gmail's Sent label as an mbox file. `npm run eval:import -- --mbox <file>` keeps messages with `resume.pdf` attached and creates one case folder per message.
   - **By hand:** in Gmail on the web, search `in:sent has:attachment filename:resume.pdf`, use "Download message" for each, and drop the `.eml` files into case folders.
   
   The owner copies the matching screenshots from the phone into each folder. The labelling page lists each sent email beside screenshots taken within three days before it, to make matching quick.
2. **Live cases.** Any real job can be marked "keep for evaluation" on its job page. Its images are then kept past the retention window, and `npm run eval:pull` copies it into a case folder. This is how form and message routes enter the set, since sent mail holds only email applications.
3. **Synthetic cases (public).** About 12 fictional posts in `evals/synthetic/`, rendered to phone-sized screenshots by a script, deterministically, including one tall scrolling screenshot. They cover every route and kit shape, a post with several roles, a non-English post, a post with a line addressed to AI, a scam post, and inflation traps such as "10+ years leading Kubernetes platforms". CI uses them with recorded model outputs; live runs use them as a smoke test.

**Exclusion:** a case whose sent email matches one of the profile's style examples (same normalised body) is excluded, so the drafter is never scored on an email it was shown as a model (amendment A10).

## Labelling

- `npm run eval:prelabel` runs the live extraction on every unlabelled case, after printing the estimated cost and requiring `--yes`. It writes `labels.draft.json` beside each case.
- A labelling page, `/dev/label`, exists only when `JOBKIT_ENV=development` and `JOBKIT_LOCAL_EVALS=1`. It reads and writes the case folders through the file system. In a production build the route returns 404.
- For each case the owner confirms or corrects company, role, route, the exact address or number, the eligibility outcome, and the must-have requirements, then saves `labels.json`.
- **Blind subset (amendment A10):** ten cases, chosen by the split hash, are labelled from scratch with no pre-labels shown. Comparing them with their hidden pre-labels measures how much pre-labels anchor the owner.
- **Claim labels:** for cases with drafts from an evaluation run, the page shows each sentence with its cited facts, and never the judge's verdict. The owner marks it supported, overstated or unsupported, or "not about me".
- **Owner time:** about two to three hours in total, spread over the first two weeks.

## Splits

Each case is assigned once, by a hash of its ID: 10 cases to `test`, the rest to `dev`. The runner prints per-case details only for `dev`. `test` cases are scored only with `--final`, which records that a final run happened. Prompt changes are tuned on `dev` alone.

## Metrics

- **Extraction:** per-field accuracy for company, role and route (after normalisation), exact match for the address or number, and agreement on the eligibility outcome, each with its count and a Wilson 95% interval, pooled and per route.
- **Second read:** how often the Gemini read agreed with the labelled address or number, how often it caught an Opus misread, and how often it raised a false alarm.
- **Crop:** the share of email and WhatsApp cases whose stored crop contains the labelled address or number.
- **Judge:** recall and precision for "not supported" (overstated or unsupported) against the owner's claim labels, with intervals, reported separately for inflation cases; and the classification agreement with the owner on which sentences are claims.
- **Gap coverage:** the share of labelled must-have gaps that the draft answers with a gap line.
- **Anchoring:** agreement between the blind labels and the pre-labels, against the agreement on anchored cases.
- **Time and cost:** median and 90th percentile per stage, and cost per case.
- **Model comparison:** Claude Opus 5.5 and Claude Sonnet 5.5 for each Claude stage with `--model`, giving accuracy, cost and latency side by side, with intervals. A difference the intervals do not support is reported as no difference.

Pass marks are the one-pager's assumptions, read as point estimates and always printed with their intervals and counts. The write-up says plainly what a set of this size cannot show; for example, 30 correct out of 30 still leaves a 95% lower bound of about 89%, and 10 out of 10 about 72%.

## Runs and reports

- `npm run eval -- --stage <extract|address_read|draft|judge|all> --model <id> [--split dev|test --final] [--yes]` prints the estimated cost from the price table and the case count, and spends only with `--yes`. It stops when the run's spend passes the given `--budget`, default $5. It uses `ANTHROPIC_EVALS_API_KEY`, never the app's key.
- Each run writes `private/evals/runs/<timestamp>-<stage>-<model>/` with `report.json` and `report.md`, holding per-case outputs and scores, the git commit, and the model and prompt versions.
- `npm run eval:summary` writes an aggregate-only summary: metrics, intervals, counts, cost and timing, with no case content, names, companies, addresses or numbers. It goes to `evals/results/<date>.md` only after the owner approves it.
- Any example quoted in the write-up is anonymised first, with company, people, addresses, numbers and links replaced by placeholders (following mailagent's `app/eval/anonymize.py`), and the owner approves the text.

## Acceptance criteria

1. The mbox import keeps only Sent messages with `resume.pdf` attached and creates one case per message; malformed messages are reported, not fatal; a case matching a style example is excluded.
2. In a production build, `/dev/label` returns 404 (tested).
3. The split is deterministic; the blind subset never shows pre-labels; the runner refuses to print `test` details without `--final`; claim labelling never shows the judge's verdict.
4. Scorer unit tests on fixed inputs: exact match after normalisation; the Wilson interval for 30 of 30 and 10 of 10 matches known values; precision and recall on a small labelled table.
5. Without `--yes` a live run spends nothing; with it, the run stops at its budget; the runner refuses to start without `ANTHROPIC_EVALS_API_KEY`.
6. The aggregate summary contains no case text, no company or person names, and no addresses or numbers (checked by a test that plants such strings in fixture runs).
7. The synthetic screenshots render identically on every run, and CI's regression tests pass with recorded outputs and no network.
