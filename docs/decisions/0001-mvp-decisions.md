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
