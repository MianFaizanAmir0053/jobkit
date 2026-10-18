# ADR 0001: MVP Decisions from the Grilling Rounds

- **Status:** Accepted, 2026-10-06
- **Decided by:** project owner, in three grilling rounds
- **Inputs:** [`docs/brief.md`](../brief.md) (source document), [`docs/ideas/job-kit.md`](../ideas/job-kit.md) (refined direction), two fresh-context reviews of the one-pager (adversarial and pre-mortem), and a check of platform limits against official documentation on 2026-10-06

The idea one-pager left questions open, and its two reviews raised more. Three grilling rounds settled them. Each entry states the choice and, where it matters, its main consequence. Later ADRs may supersede individual entries; they must say which.

## Round 1

1. **Hosting and stack.** Next.js (TypeScript) on Vercel Hobby, with Supabase Free for Postgres and file storage.
   - The tool stays reachable when the laptop is off. The laptop alternative failed on two counts: mailagent's tunnel already uses the only free ngrok domain, and free ngrok domains put a warning page in front of browser traffic.
   - Phone uploads go straight to Supabase Storage, because Vercel caps request bodies at 4.5 MB.
   - The pipeline runs inside Vercel's 300-second function limit (Fluid compute, Hobby plan).
   - The app is installed on the phone as a PWA.
2. **Model provider.** Claude Opus 5.5 for every stage. The evaluation runs the same cases on Claude Sonnet 5.5 and Claude Haiku 4.5, so a stage can switch models on evidence. A Gemini adapter comes only if the owner asks for it later. Real data goes only to paid API tiers.
3. **Past applications.** The evaluation set is seeded from Gmail Sent (emails with `resume.pdf` attached) and the matching screenshots in the phone gallery, kept in the gitignored `private/` folder. Fewer than 20 cases are topped up with live applications in week 1.
4. **Repository visibility and personal data.** The repository is built to go public later.
   - Profile, CV, screenshots, real evaluation cases and tokens never enter git. The repository ships a fictional sample profile and synthetic posts for the demo and for CI.
   - Real results are published as aggregates only. Recruiters' names and addresses are never published, and any published example is anonymised or synthetic.
   - Screenshots are deleted after 90 days unless marked for the evaluation set.
5. **Sending address.** `faizanamir0053@gmail.com`, the contact address on the portfolio.
6. **CV.** One CV: `Portfolio/public/resume.pdf`, copied into the tool's storage. The version sent is logged with each application. Variants come only if the evaluation shows a need.
7. **Clocks and targets.** The clock starts when the owner shares or uploads the post.
   - Machine time, from share to draft on screen: at most 60 seconds at the median.
   - Total time, from share to Sent (email) or to the owner's Submitted tap (form and message routes): at most 2 minutes at the median, and at least twice as fast as the baseline.
   - Baseline: 10 applications in the current manual workflow, timed in week 1 with an in-app stopwatch.
   - Reports give the median and the 90th percentile.
8. **Profile authorship.** Facts are drafted from `resume.pdf` and `Portfolio/src/data/projects.ts`. Each fact has an ID, a source and an approved flag. The owner approves or edits every fact, and only approved facts can appear in drafts. The owner also writes:
   - gap templates, such as "I haven't used X professionally; the closest is Y", which the model fills with a cited related fact;
   - lines for known gaps;
   - fixed answers: salary expectation, notice period, work authorisation and sponsorship per country, time-zone overlap, availability, years per stack, and EEO preferences.
9. **Claim check.** Every draft sentence has a class.
   - A claim must cite approved facts. Code rejects unknown fact IDs, and a judge model checks each claim against the facts it cites.
   - A gap line cites the requirement it answers. Every must-have requirement marked Gap or Partial must get an honest line, or the draft is flagged.
   - A courtesy line (greeting, thanks, sign-off) is exempt.
   - An unsupported sentence is highlighted and blocks Send until the owner edits it or confirms it with "I checked this". The check re-runs on the final text; text the owner typed needs one confirming tap.
   - The evaluation scores the judge against the owner's labels and includes inflated claims (years, scale, "led"), not only missing skills.
10. **Undo window.** Once send exists, a 15-second countdown runs before an email goes. Undo cancels it, and so does leaving the page.
11. **Duplicates.** An application matches an earlier one on company plus normalised role (hashed), on the application address, or on the post text. Reposts match on company plus role. A match shows the earlier date and needs an "apply again" tap. Every draft carries an idempotency key, so a retry or a double tap cannot send twice.
12. **Company statements.** Kits say things about the company only when the post says them. The MVP does no web research.
13. **MVP end point and trust gate.** The MVP ends at the kit. Email kits hand off to the Gmail app with To, Subject and Body prefilled, or through an Android share with the CV attached; the spec picks whichever takes fewer taps. One-tap send is built last and stays locked until the trust gate opens (entry 20).
    - Cut line: if time runs out, the MVP is the kit plus the handoff.
    - Link fetchers for Greenhouse, Lever and Ashby are cut. The owner pastes the post text instead.
14. **Pairing and send security.**
    - The QR code appears only on a laptop page signed in with Google as the owner.
    - Its token is single-use, lives 2 minutes and travels in the URL fragment, never the query string, so it never reaches server logs.
    - The laptop lists paired devices, each with Revoke.
    - A passkey is registered at pairing, and Send needs a fingerprint.
    - At most 15 sends a day.
    - Each Send approval is bound to a hash of the exact To, Subject, Body and attachments. Any change needs a fresh approval.
15. **Untrusted post text.**
    - Extraction returns the post's instructions to applicants as a typed checklist. The drafting model never treats raw post text as instructions.
    - Lines addressed to AI are flagged and never followed.
    - Requests for a CNIC, passport, bank details or fees raise a scam warning.
    - A required attachment other than the CV blocks Send until the owner ticks it as handled.
    - Work authorisation, sponsorship, salary and EEO answers come only from fixed profile fields.
    - Citation markers are stripped from copy-ready text.
    - Models that read posts hold no tools.
16. **Address check.** This replaces the one-pager's "domain fits company" check, which was circular.
    - The To address is shown large beside the part of the screenshot it came from. The model returns an approximate box, which the evaluation checks; if cropping fails, the full screenshot is shown and can be zoomed.
    - A second, independent read of the address must agree with the first.
    - The domain must be able to receive mail: MX records, or an A record when there is no MX (RFC 5321's implicit MX). Send is blocked only when the domain has neither.
    - Warnings, not blocks: free-mail domains, domains registered within the last 90 days (RDAP lookup), and a domain that does not match the company.
17. **Route mix and earlier applications.** The share of email, form and other routes is unknown and is measured from the log. The duplicate log is seeded from a list of earlier applications the owner types (company, role, date). Importing the Sent-mail metadata mailagent already syncs stays an option for later.
18. **Eligibility gate.** Before drafting, the post's location limits, work-authorisation, sponsorship and time-zone demands are checked against the owner's fixed facts. A mismatch shows "Likely ineligible: <reason>" with Draft anyway and Skip.

## Round 2

19. **Google OAuth.** A separate Google Cloud project, "jobkit".
    - Sign-in asks only for `openid` and `email`. The `gmail.send` scope (Sensitive, not Restricted) is requested only when send unlocks.
    - The app is set to "In production" without verification. Google allows this for personal use under 100 users; it shows a warning screen and calls the setup "strongly discouraged". Refresh tokens then lose the 7-day expiry that Testing status imposes.
    - A token still dies on revocation, a password change or 6 months without use. The app then shows a banner and falls back to the Gmail handoff.
    - The refresh token is encrypted at rest with AES-256-GCM; the key lives in a Vercel environment variable.
20. **Trust gate.** An edit that touches a claim sentence counts as factual; other edits count as style. Rewording a claim also counts as factual, which keeps the gate conservative.
    - Send unlocks after 10 email drafts in a row with no factual edit.
    - A factual edit after unlocking locks it again, and 5 clean drafts unlock it.
    - The app shows the counter.
21. **Draft style.**
    - British spelling.
    - Body of at most 180 words, plain text.
    - Subject in the post's format when it gives one, otherwise "Application: {Role} – Faizan Amir".
    - Greeting "Dear {Name}," when the post names a person, otherwise "Dear Hiring Team,".
    - The signature is a profile fact: name, portfolio link, LinkedIn, GitHub and WhatsApp number. The Gmail API does not add the Gmail signature.
    - Three to five of the owner's best past emails serve as style examples.
22. **Profile editing.** The profile is a YAML file in `private/`, edited on the laptop. A seed script pushes it to Supabase, and the app reads the database. The owner backs up `private/` outside git. An in-app editor may come later.
23. **Git and deploy.** A private GitHub repository. Vercel deploys on push. GitHub Actions run the tests with no secrets and no private data. A pre-commit check blocks `private/` paths and key-like strings, so the history stays safe to publish.
24. **Spend.** A new Anthropic API key, "jobkit", in its own Console workspace with a $30 monthly limit. The app refuses new jobs once the month's logged cost passes $25, warns at $20, and shows the month's spend.
25. **Push notifications.** None in the MVP. The job page shows progress, and the jobs list shows status.
26. **Supabase project.** A new free project for jobkit if the account has a free slot; the Free plan allows two active projects and mailagent uses one. Otherwise jobkit shares mailagent's project, in its own schema with its own database role and storage bucket. A daily Vercel cron touches the database, so the 7-day inactivity pause never triggers.

## Round 3

27. **Evaluation labelling.** The model pre-labels each archived case, and the owner corrects the labels on a review page, about a minute per case. Ten cases are held out from prompt tuning and scored only for the reported numbers. Results carry confidence intervals; 30 cases cannot show 95% accuracy, and the write-up says so.
28. **Message kit.** A third kit shape for posts that say "send your CV on WhatsApp", "DM me" or "comment interested": a message of at most 600 characters, plus the CV.
    - WhatsApp opens through the official `wa.me` click-to-chat link with the text prefilled; the owner attaches the CV.
    - LinkedIn messages and comments are copy-only; the owner posts them.
29. **Look.** Neutral shadcn components in dark mode, with the portfolio's lime as the accent colour.
30. **Write-up.** In week 4: a README case study and an entry in `Portfolio/src/data/projects.ts`. Every number carries a method note and an interval. Nothing is published until the owner approves the text and a history check passes.

## Defaults (accepted with the rounds)

- **Stack details:** Next.js 16 App Router, TypeScript in strict mode, Tailwind CSS v4 with shadcn, Auth.js v5 with Google (owner only, as in mailagent's web app), Supabase Postgres and Storage, and Vitest. Playwright is used only to test jobkit itself.
- **Input:**
  - The in-app upload button is always available. The Android share target is an extra, tested on the owner's phone on day 1: a third-party report from 18 September 2026 says Chrome 153 on Android delivers share requests without their files.
  - One share or upload with several images is one job. More screenshots, such as an application form's screening questions, can be added to a job later.
  - Pasted text is accepted.
  - When a post lists several roles, the owner picks one.
- **Jobs list:** statuses are kit ready, sent, submitted, skipped and bounced (the owner marks bounces). Several jobs can run at once.
- **Language:** English posts only; others are flagged.
- **Phone session:** lasts 180 days and can be revoked.
- **Evaluation runs** happen on the laptop against private data; only aggregates leave it.

## Consequences

- Until the trust gate opens, every email goes out through the Gmail app, and the MVP stands without one-tap send.
- The owner sets up five accounts or projects: Google Cloud, an Anthropic workspace and key, Supabase, Vercel and GitHub. The owner enters every credential; none goes in chat or in the repository.
- Owner time needed: approving profile facts, writing gap templates and fixed answers, labelling about 30 evaluation cases (30 to 45 minutes), timing 10 manual applications, and typing the list of earlier applications.
- Running cost is about $0.15 to $0.20 per application on Claude Opus 5.5, capped at $25 a month by the app.

## Review findings carried in

The two reviews of the one-pager raised 23 findings and none was dismissed. Their fixes appear in entries 4, 7, 9, 11, 13 to 16, 18 to 20, 26 and 27, and in the input defaults. Points the one-pager had dropped from the brief without saying so are restored: the portfolio link (entry 21), application status (defaults) and reposted listings (entry 11). The brief's single fit score is replaced, on purpose, by the per-requirement table.

## Amendments (2026-10-06, after the reviews of this record)

Two fresh-context reviews of this record, one adversarial and one taking the view of the developer who must build it in four weeks, raised 22 findings. None was dismissed. The owner adopted amendments A1 to A10; the fixes in A11 follow from decisions already made and are applied directly in the module specs.

### A1. One-tap send moves to milestone 2 (supersedes entry 10, the build order in entry 13, the passkey and send parts of entry 14, the `gmail.send` part of entry 19, and the unlock in entry 20)

The four-week MVP ends at the kit, the handoff and the log. The `send` module is specified in `SPEC-send.md` and marked deferred; it holds every send-path finding. The trust-gate counter and the factual-edit rate are recorded from day 1 as metrics, so milestone 2 starts with evidence. The reason: the gate was unlikely to open within four weeks (ten clean email drafts in a row, with email's share of applications unknown and send built last), while the send path carried the most new code and the most hazards.

### A2. Own sign-in code instead of Auth.js (supersedes the Auth.js default)

Google sign-in uses `arctic`. Sessions live in a jobkit table, one row per device, following a well-known recipe: a random token in an HttpOnly cookie, stored only as a hash. The device list is the session list, and Revoke deletes the row. The reasons: Auth.js is in security-patch-only mode; its JWT sessions cannot revoke a single device (mailagent revokes by rotating its secret, which signs out every device); and every special rule here (re-authentication before pairing, approval of new devices) needs own code anyway.

### A3. QR pairing gains two guards (refines entry 14)

Creating a QR code needs a Google sign-in within the last 5 minutes. After a phone redeems the code, the laptop shows the new device ("Approve Android · Chrome?"), and the phone's session works only once the owner approves it there. A stolen laptop cookie alone can no longer pair a phone.

### A4. Second read by Gemini Flash (refines entries 2 and 16)

The second, independent read of an application address or WhatsApp number uses Gemini Flash on a crop made by code, through the owner's paid Gemini key, so the two reads do not share one model's misreadings. When the reads disagree, the owner retypes the address or number; picking one of the two reads is not enough.

### A5. No domain-age check (supersedes the RDAP part of entry 16)

IANA's RDAP bootstrap has no server for .io, .ae, .pk, .de, .sa and other domains common in the target markets, so the warning would silently skip most of them.

### A6. No shared Supabase project (supersedes the fallback in entry 26)

mailagent's project holds the owner's synced mail, and project-wide credentials would reach it. If the account has no free slot, the owner pauses or deletes another free project, or jobkit uses Neon's free Postgres with separate file storage.

### A7. Retention (refines entry 4)

- Screenshots are deleted after 30 days unless kept for evaluation.
- Extracted records, drafts and recruiter names are deleted 180 days after the job's last status change.
- The application log (company, role, route, dates, status and address) is kept for duplicate checks.
- Evaluation data stays on the laptop, except what evaluation runs send to the model providers' paid APIs.

### A8. Interleaved baseline (refines entry 7)

Every third application in weeks 1 to 3 is done the old manual way and timed, instead of ten manual applications in week 1, so job mix and the owner's own speed-up do not skew the comparison. Both arms start at the same moment: the owner has the post in hand and taps Start (manual) or shares it (tool). Medians are reported per route as well as pooled.

### A9. Separate evaluation spend (refines entry 24)

A second Anthropic key, "jobkit-evals", in its own Console workspace with a $15 monthly limit, so evaluation runs can never stop the app. The app's $25 cap stays until the real cost per job is measured on day 3. The reviews estimate $0.35 to $0.45 per job with Claude Opus 5.5, which would cap the month at about 60 jobs; the owner then decides the cap, or a cheaper model per stage on evidence.

### A10. Honest labelling (refines entries 2 and 27)

- Ten cases are labelled blind, without pre-labels, to measure anchoring.
- Claim labels never show the judge's verdict.
- Cases whose emails serve as style examples are excluded from the evaluation set.
- The model comparison for the Claude stages covers Claude Opus 5.5 and Claude Sonnet 5.5; Claude Haiku 4.5 has a different thinking API and a lower image resolution.
- Realistic owner time for labelling is two to three hours.

### A11. Fixes applied directly in the specs

- The judge, not the drafter, classifies every sentence, and an unclear sentence counts as a claim. Statements about the company form a `post` class that cites the record field they come from. Short form answers drafted by the model count as claims.
- Every outbound action is gated: copy buttons, the Gmail handoff and the WhatsApp link.
- Addresses are validated strictly and every part of a `mailto:` link is encoded, so a post cannot smuggle in a Bcc or extra headers. A null MX blocks.
- WhatsApp numbers are normalised and get the same crop and second read as addresses.
- Tall scrolling screenshots are cut into overlapping tiles within the model's 2,576-pixel limit instead of being shrunk; coordinates map back through the tile offsets.
- The job has an explicit state machine with a Retry action, and machine time excludes time spent waiting for the owner.
- Mark sent asks "Did you change anything in Gmail?". The answer counts towards the factual-edit rate, which also counts edits to the address, subject, company or role names, greeting name and gap lines.
- A GitHub Actions schedule calls the keep-alive endpoint every 8 hours, because Supabase asks for a few database requests a day and Vercel Hobby cron runs only daily.
- The plan carries a ranked cut list of features.

## Refinements from the spec reviews (2026-10-06)

Three fresh-context reviews of the module specs raised 36 findings; none was dismissed. Most changed only the specs. These refine decisions recorded above, and one corrects a spec that had drifted from this record.

### A12. Pairing is confirmed by a code (refines A3)

Sessions are of two kinds by how they were made: `google` (a Google sign-in, on any device) or `paired` (a QR pairing). After a phone redeems a QR code, it shows a 6-digit code, and only the session that created the QR code can approve the phone, by typing that code while its own Google sign-in is still within 5 minutes. Someone who redeems a leaked QR code first cannot be approved by mistake, because the code the owner sees on their own phone does not match. Session lifetimes are absolute: 30 days for `google`, 180 for `paired`. Google's `sub` is pinned at the first sign-in.

### A13. Timing arms are assigned at random (refines A8)

Real use starts at the first handoff of a kit made by jobkit. From then to the end of week 4, the server assigns each new job to the manual arm with probability one in three when the job is created; the owner cannot choose or swap. Both arms start at the same event, the share or upload reaching jobkit. Manual runs from before real use are reported separately and never enter the comparison, which carries bootstrap 95% intervals.

### A14. No jobkit signature on Gmail handoffs (refines entry 21)

The Gmail app adds the owner's own Gmail signature to a handoff draft, so email kits carry none; the runbook has the owner set Gmail's mobile signature to the profile's signature once. Message kits keep the profile's sign-off, and milestone 2's API send will append it.

### A15. Company statements limited to name, role and requirements (refines entry 12)

The job record holds no description of the company, so kits mention the company only by name, the role only by title, and requirements only as the post states them. A sentence that says more is flagged for the owner.

### A16. Duplicate rule restored to entry 11

A spec had made address-only matches informational and dropped post-text matching, without the owner's decision. Both are restored: every match (company and role, address, post text, existing draft) needs "apply again". Post text matches by similarity of the requirement texts, so a reworded repost is caught, and normalisation ignores punctuation and spacing ("Front-End", "Front End", "Frontend").

### A17. Evaluation design (refines A9 and A10)

The ten held-out test cases are the ten labelled blind, so the headline numbers rest on labels no model shaped. The judge is measured on a frozen set of at least 80 sentences written against the owner's real facts and labelled once. Model comparisons use an exact McNemar test on the same cases. A month's planned evaluation runs cost about $14, inside the $15 evaluation workspace.

## Changes during the build

### A18. Gemini at every model stage (2026-10-14; refines entry 2, A4, A9 and A17)

The owner has no Claude API key, so every model stage runs on Gemini, through the Gemini adapter the second read already used: `extract`, `draft` and `judge` on Gemini 3.8 Flash, and the second read on Gemini 3.6 Flash, so the two reads of a contact still come from two models. Flash rather than Pro: Gemini 3.1 Pro, in preview, has no free tier and costs about three times as much, while both Flash models have a free tier and cost $0.75 and $3.75 per million tokens on the paid tier, doubling from 2027-01-01 (Google's pricing page, 2026-10-14). The Claude adapter and its prices stay, so a stage returns to Claude by changing its model ID once there is a key. Local runs and evaluations need only `GEMINI_EVALS_API_KEY`; the evaluation runner asks for the key of the model it runs. What follows from it:

- The two reads of a contact come from two Gemini models rather than two providers, so they may share more of their mistakes; the evaluation's second-read metric measures it.
- `extract` asks for the contact's box in tile pixels, while Gemini gives boxes natively as `[ymin, xmin, ymax, xmax]` in thousandths of the image. A box given that way misplaces the crop, which only leaves the second read missing, so the owner types the address. The first live runs show which Gemini gives; if it is thousandths, `extract` asks for them and code converts.
- On Gemini's free tier, Google may use what jobkit sends, the profile's facts and the posts included, to improve its products; on the paid tier it does not. The owner chooses the tier with the key.
- The evaluation's model comparison becomes Gemini 3.8 Flash against another Gemini model (Gemini 3.1 Pro on a paid key), and a month's planned evaluation runs cost about $5 at Gemini's prices.
- Images are still cut to the tile geometry made for Claude; Gemini reads such tiles, and the cost estimate, which counts their tokens at Claude's rate, errs high.
- The commit guard also finds Google API keys of the newer `AQ.` form.

### A19. The draft at low thinking (2026-10-14; refines entry 2 and A18)

Measured on the owner's first job from the phone: the upload took 14 seconds, `extract` 30, `draft` 63 (59 for its answer, 7,652 output tokens, mostly thinking) and `judge` 9, about two minutes in all. Every stage's first call met Gemini's 503 "high demand" and succeeded on its retry, a few seconds each. The draft moves from medium to low thinking; `extract` stays at medium, since it reads the contact and the lines aimed at AI. The evaluation measures both again.

### A20. One-click send through the Gmail API (2026-10-14; supersedes A1's move of one-tap send to milestone 2, and refines entries 10, 19 and 20, and A14)

The owner found the handoff too many steps, and chose to approve and send in one click. They connect Gmail once, from a page in jobkit, with the `gmail.send` scope (and `openid email`, to check that the account is the owner's): jobkit can send mail but never read it. Google's consent screen needs that scope and the Gmail API enabled in the project; the owner publishes the app, so the connection does not lapse after seven days, and passes Google's unverified-app warning once. The refresh token is kept encrypted with `GMAIL_TOKEN_KEY`, never sent to the browser, and revoked on Disconnect.

On a ready email kit, "Approve & send" asks to confirm the address, the subject and the attached CV, then sends after ten seconds unless the owner presses Undo, since the Gmail API cannot unsend. The email ends with the profile's signature, as Gmail adds none to an API send, and carries the profile's CV. The press counts as "I checked this" on every flagged sentence and flag shown above the button, those that ask for words changed in Gmail included. These still hold the button until the owner acts on them: an address jobkit could not confirm, a blocking address check, a possible repeat, a scam warning, and any attachment besides the CV, which jobkit cannot attach yet. A sent email is marked sent with its Gmail message ID, and its Mark sent cannot be taken back. Open in Gmail and Mark sent stay as the other way to send.

### A21. Templates first, and ranked drafts (2026-10-14; refines entries 2, 5 and 12)

The profile gains email templates: four to six bodies for kinds of role (full-stack, AI, backend, frontend and a general one), each paragraph citing the approved facts it rests on, drafted by Claude Code and approved by the owner as facts are. For each post, code scores every approved template by the share of the chosen role's must-haves its facts cover; the two best that cover at least 60% become drafts at once, with code filling the greeting, company, role and gap lines, and their approved sentences need no separate check. A Gemini draft is written beside them as now, and judged; when no template reaches 60%, it is the only draft. The drafts are ranked by must-have coverage, then by fewer open flags, then by length within the limit, and the first is labelled Recommended. The owner can pick any of them, and the gate, the decisions and the send follow the draft picked.

### A22. Gemini on request beside the templates, and the words Approve & send cannot change (2026-10-14; amends A20 and A21)

The owner chose speed ("use them first, but if they dont match then generate a new one"), and a kit cannot be ready while a stage still runs. So when a template covers at least 60% of the role's must-haves, the kit is ready at once with up to two template drafts, ranked, the first Recommended, and no Gemini call is made. Drafting starts with a code-only stage, `templates`, with the address stages beside it, as they are beside `draft`. A Gemini draft beside the templates' comes on request: "Write a draft with Gemini too" runs drafting again (`kit_ready` to `drafting` with `draft`), the judge checks it, and the kit is ready again with it ranked among them; should it fail, "Back to your drafts" makes the kit ready again with the templates' drafts (`failed` to `kit_ready`). When no template reaches 60%, Gemini drafts the email as before. No separate check weighs a template draft, so it holds only the owner's approved words, each word for word: the template's sentences, approved facts and known gap lines; code writes no gap line of its own, and a must-have that neither a fact nor a known line answers leaves the post to Gemini. What code cannot weigh (a degree, a language, a skill outside the vocabulary) is flagged for the owner to confirm, and a post that asks for a keyword the templates lack goes to Gemini. The drafts are ranked by the share of the weighable must-haves they meet, then by fewer flags and findings to check, then by fewer words, a template's before Gemini's on a tie. The owner's pick is kept with the kit's review: decisions on sentences and flags count for the draft they were made on and come back with it, while those on the post (a typed address, an attachment's tick, "Continue anyway") go with the pick; asking for Gemini's draft keeps the draft shown. Each email's outcome records which draft went. A template must make at least one claim.

Approve & send sends the words as they stand, so it no longer counts as "I checked this" on the flags that make an email wrong to send as it stands: a line the owner must write, a placeholder in the subject, a reference's details, a line written for an AI tool, and a must-have the owner said they do not meet, until a line of theirs answers it (added 2026-10-19, the owner's choice). A kit with one is sent from Gmail, where the owner changes the words, or the owner changes them on the job page (the block editor, Task 29), where validate runs again. The press still takes the other flags as they stand (a missing keyword, the length, a must-have with no gap line, no claims), as its confirmation lists them.
