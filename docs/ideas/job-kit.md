# Job Kit

> Revised on 2026-10-06 after two adversarial reviews and three grilling rounds. The decisions and their details are recorded in [ADR 0001](../decisions/0001-mvp-decisions.md).

## Problem Statement

How might we turn a job post spotted on the phone into an honest, tailored application ready to send in under two minutes, without ever sending a claim the owner has not checked?

## Recommended Direction

A standalone personal tool, also built as a portfolio case study. The owner shares a job post from their Android phone, as one or more screenshots or as pasted text, into the tool's web app. A vision model turns it into a structured record: company, role, location and eligibility limits, salary, must-have and nice-to-have requirements, the application route, the address or link, and the post's instructions to applicants as a typed checklist. Post text is untrusted. Lines addressed to AI are flagged and never followed, requests for national ID or bank details raise a scam warning, and the models that read posts hold no tools. Before drafting, an eligibility check compares the post's location, work-authorisation, sponsorship and time-zone demands with the owner's fixed facts. The record is then matched against the owner's profile, a set of facts the owner has approved, each with an ID and a source, into a table that marks each requirement Met, Partial or Gap.

The tool returns a kit in one of three shapes. An email kit holds To, Subject and Body, with the CV. A form kit holds a cover note, answers to the post's questions and the owner's standard answers. A message kit holds a short note for WhatsApp or LinkedIn. Every claim in a draft cites an approved fact, and a judge model checks that the fact supports it. Every must-have Gap or Partial gets an honest line built from the owner's own template, and statements about the company come only from the post. In the MVP the owner sends email through the Gmail app, which the tool opens with the draft prefilled. One-tap sending through the Gmail API is built last and unlocks only after ten email drafts in a row need no factual edit, which restores the brief's rule of sending automatically only "once you trust the drafts". Once unlocked, code sends, never a model, and only after the owner has seen the address beside the screenshot it came from, a second read of the address agrees, the domain can receive mail, a fingerprint confirms, and a 15-second undo window passes.

The phone pairs with the tool once by scanning a QR code on the laptop, the same gesture as WhatsApp Web. The code is issued only from a laptop session signed in with Google as the owner, works once, expires in two minutes, and every paired device can be revoked. Each application is logged with its route, timings, cost and status, plus the Gmail thread ID once the tool sends, so that reply tracking can come later, from this tool or from mailagent.

## Key Assumptions to Validate

Each assumption has a pass mark and a consequence. Results carry confidence intervals, because 30 cases cannot prove 95% accuracy.

- [ ] Extraction reads the application address exactly on every labelled case, and company, role and route on at least 90%. A wrong address keeps the side-by-side check mandatory and gets investigated; route accuracy below 80% adds a manual route picker.
- [ ] The tool is faster: total time from share to sent or submitted is at most two minutes at the median and at least twice as fast as the timed baseline of ten manual applications. If not, the timing log shows which step to cut.
- [ ] Drafts need only light edits: the trust gate opens within the first 20 real uses. If it never opens, send stays locked and the MVP is the kit.
- [ ] The judge catches at least 90% of unsupported sentences in a labelled set that includes inflated claims (years, scale, "led"), not only missing skills. If not, every claim sentence needs the owner's tick.
- [ ] Mail sent through the Gmail API from the owner's account lands in the inbox, tested with a second address and a mail-testing service before send unlocks. If not, the Gmail handoff stays.
- [ ] Uploads from the phone succeed at least 95% of the time over a week, on mobile data. The Android share target is tested on the owner's phone on day 1; if it fails, the upload button carries the flow.
- [ ] Email is a large enough share of applications to justify one-tap send. The log measures the route mix; if email is under 30%, the form and message kits come first.

## MVP Scope

In:

- input as screenshots (upload, plus the share target if it works) or pasted text, with more screenshots added to a job later, such as a form's screening questions;
- extraction with the instructions checklist, the untrusted-input rules and the eligibility check;
- the approved-fact profile, per-requirement fit, gap templates and fixed answers;
- email, form and message kits, with the claim check;
- QR pairing, the jobs list and the review page;
- the Gmail app handoff for email kits;
- the application log: statuses, timings, cost, duplicate warnings, and a seeded list of earlier applications;
- the evaluation set built from past applications, with a held-out split;
- last, one-tap send behind the trust gate.

Cut line: if time runs out, the MVP ends at the kit and the handoff.

## Not Doing (and Why)

- **LinkedIn Easy Apply automation.** It breaks LinkedIn's User Agreement and risks the owner's account. The form kit covers Easy Apply by copy and paste.
- **Fetching LinkedIn links.** Scripted fetching counts as scraping under the same agreement. LinkedIn links are stored as references only.
- **Fetching ATS links (Greenhouse, Lever, Ashby).** Cut to keep the MVP small and to avoid handling hidden page text; the owner pastes the post text.
- **Playwright form filling.** A phone user cannot watch or submit a browser running elsewhere, and Workday needs an account per company. Copy-ready answers give most of the speed.
- **Telegram.** Blocked on the owner's network.
- **WhatsApp bots.** The Business API needs Meta setup and a separate number, and sits in a grey area under Meta's rule against AI-provider bots, in force since 15 January 2026. Unofficial WhatsApp libraries break WhatsApp's terms and risk a ban. The message kit uses WhatsApp's official click-to-chat link instead.
- **Sending without review.** Unchecked claims to employers are the failure this tool exists to prevent.
- **One-tap send before the trust gate.** The brief made it a second version, added "once you trust the drafts".
- **Job-alert inbox.** Alert emails carry title, company and link only, so a draft still needs the full post. A candidate for later.
- **Follow-ups and reply tracking.** They raise the reply rate, not the speed per job. The logged thread IDs make them cheap to add later.
- **Merging into mailagent.** Keeps both case studies focused and this one quick to ship. The thread-ID seam keeps the door open.
- **Other users.** One owner: no accounts, billing or Google verification for strangers.
- **Push notifications.** The job page shows progress; push can come later if batching jobs needs it.
- **Company research on the web.** Statements about the company come only from the post.
- **Non-English posts.** Flagged, not drafted.
- **A single fit score.** Replaced by the per-requirement table, which shows why a job fits or does not.

## Open Questions

None blocking. ADR 0001 records the decisions. The spec settles the remaining implementation choices, such as the handoff mechanism (chosen by tap count) and the pipeline layout within Vercel's 300-second function limit.
