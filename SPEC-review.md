# Spec: review

- **Module id:** `review` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `drafting`, `ledger`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 9, 11, 13, 15, 16, 18, 21, 28 and 29, the status default, and amendments A1, A4, A5, A8 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A; job states from platform B9
- **Status:** approved by the owner on 2026-10-06, after two review cycles

## Objective

Put everything the owner must check on one phone screen, refuse every outbound action while a blocking issue stands, and hand the finished kit to Gmail, WhatsApp or the clipboard with as few taps as possible. Stage registered with the platform's runner: `address_checks`, which runs in the `drafting` group beside `draft` and `address_read`.

## Jobs list

`/jobs` lists jobs newest first, with company, role, route, state or status, and a progress label while the pipeline runs. Failed jobs show their reason, Retry and Skip; jobs in `upload_failed` show "Upload again" and Skip. Opening the list resumes running jobs, and the list polls only while some job is running (platform B9).

## Job page

`/jobs/<id>`, laid out for a phone. What it shows depends on the job's state.

**Waiting and special states:**

- `manual_run`: "This one is a manual run: apply the old way, then tap Stop", a running stopwatch, and Stop, which asks for route, company and role (ledger spec).
- `needs_role_pick`: the roles with title, location and route, and Skip.
- `needs_eligibility_decision`: the reasons, with Draft anyway and Skip.
- `needs_kit_type`: email, form or message, and Skip.
- `stopped`: the reason. For "not a job post", the button "This is a job post" sends it back to extraction.
- `failed`: the stage, a readable reason, Retry and Skip.
- `upload_failed`: "Upload again" and Skip.
- While a stage runs: state names and elapsed seconds.

**The kit (`kit_ready`), from top to bottom:**

1. **Banners**, most serious first:
   - scam warning (red), quoting the signals;
   - duplicate matches from the ledger, each with its reason, the earlier role and the date;
   - unclear eligibility reasons;
   - the spend warning.
2. **Contact panel** (email and WhatsApp kits): the address or number in large type, the enlarged crop beside it, and the second read's result. When the reads disagree, or no crop exists, the full screenshot is shown, zoomable, with a field asking the owner to retype the address or number. Below them, the address checks, each with a plain reason.
3. **Checklist:**
   - every instruction from the post, marked applied, declined, not applied, or "Not followed: addressed to AI". The owner can decline an applied subject format, word limit or keyword, which rebuilds the subject or clears the flag it caused;
   - required attachments, each with a tick box;
   - screening questions addressed to AI, marked "Not answered".
4. **Fit table:** each requirement with Met, Partial or Gap; tapping a verdict shows the cited facts; `fit_unverified` and `fit_missing` rows say why, and requirements that need the owner's tick (a language, an "other" requirement) offer it.
5. **Draft:**
   - email: To and Subject as fields, and the body as a list of blocks, each editable on its own, with buttons to add or delete a block. A note says the Gmail app adds the owner's Gmail signature;
   - form: the cover note as blocks, and each answer with a copy button; topic answers marked "from your profile"; a question only one classifier tied to a topic offers "Use my profile answer" or "Draft it"; "Needs your answer" fields where the question or the profile lacks what the answer needs;
   - message: the message as blocks, and a copy button.
   
   Flagged blocks are highlighted with their reason. Each flagged block offers "I checked this"; each drafted short answer offers a tick; a gap without a usable line shows "Needs your line"; a block the owner wrote can be marked as answering a requirement.
6. **Actions:** the handoff buttons, the status buttons and Skip.

Images and crops reach the page only through signed URLs that last 60 seconds.

## Stage `address_checks`

Runs for email routes in the `drafting` group, and again whenever the owner edits the To field. A result is kept with its input (the address, the company and the checks' version), so the same address is not looked up again. Checks made for another address than the one that stands, or missing once the second read ran, block as not checked. The test server's DNS gives every domain a mail host, so end-to-end tests run offline.

- **Syntax:** the strict address check (extraction spec). Failure is blocking.
- **Mail host:** MX records for the domain. With no MX, an A or AAAA record counts as the implicit MX of RFC 5321. A null MX (a single MX record pointing to ".", RFC 7505) or no records at all is blocking. A DNS timeout (3 seconds) gives "Couldn't check the mail server", a warning.
- **Free-mail domain** (gmail.com, googlemail.com, yahoo.*, outlook.com, hotmail.*, live.com, icloud.com, proton.me, protonmail.com, aol.com, gmx.*, yandex.*, mail.com, rediffmail.com): warning, "A personal address, not a company one."
- **Company mismatch:** the registrable domain's label (`tldts`) compared with the normalised company name, ignoring hyphens and words such as "careers", "jobs", "hr" and "recruitment". No overlap gives a warning, never a block, because agencies and parent companies are common; a domain made only of such words ("careers-hiring.com") names no company and warns too.

There is no domain-age check (amendment A5).

## The outbound gate

`canHandOff(job, kit)` is one pure function, bundled for the browser and run on the server too. Every outbound control uses it: the Gmail handoff buttons, every copy button, "Copy all", "Open WhatsApp" and "Open application link". It returns the open blocking reasons:

- any flag from drafting's `validate` that is unresolved, including `overstated`, `unsupported` and `company_claim` sentences without "I checked this", unticked short answers, and "Needs your answer" fields;
- a changed sentence awaiting the owner's confirmation;
- a required attachment without its tick;
- a disputed or missing address or number not yet retyped by the owner;
- a blocking address check;
- a duplicate match (any reason) without "apply again";
- a scam signal without the explicit "Continue anyway" override.

The page runs `validate` and `canHandOff` in the browser on every edit, so the controls enable or disable at once with the reasons listed above them. The server runs the same functions on the same text, debounced, and records the result; a control enables only when both agree. Clicking a control never waits for the server first: the handoff happens inside the click, which Android needs for the share sheet, and the final text and outcome are posted right after.

## Handoffs

- **Email.** Two mechanisms are built for the tap-count spike, and the one that takes fewer taps on the owner's phone stays:
  - **A:** "Open in Gmail" follows a `mailto:` link built by code: the address after the strict check, then `subject` and `body`, each part encoded with `encodeURIComponent`, so nothing in a post can add a header or a recipient. The owner attaches the CV in Gmail; the job page offers the CV for download once, after which it sits among Gmail's recent files.
  - **B:** "Share with CV" copies the address and subject to the clipboard, then calls the Web Share API with the CV file and the body text. It is shown only where file sharing is supported.
  
  The page reminds the owner to check that Gmail's From shows `faizanamir0053@gmail.com`, and to make changes in jobkit rather than in Gmail. Until the block editor exists (Task 29), it says instead that a change to the email's wording in Gmail is answered Yes when asked, and that attaching the CV does not count (the owner's decision, 2026-10-12). Afterwards it asks "Did you send it?" with Mark sent and Not yet. Mark sent then asks "Did you change anything in Gmail?" (Yes or No), and the ledger records the outcome.
- **Form.** Copy buttons per field, "Copy all" (cover note and answers as labelled plain text), and "Open application link" only for an `https` link (any other link is shown as text with a warning). Then Mark submitted.
- **Message.**
  - WhatsApp: "Open WhatsApp" builds `https://wa.me/<number>?text=<message>` from the normalised number (extraction spec), with the message encoded.
  - LinkedIn: copy only. The owner posts the message or comment.
  
  Then Mark submitted.
- **Always available:** Skip; and on sent jobs, Mark bounced.

## Look

Neutral shadcn components on the dark theme with the lime accent (platform A2). Touch targets at least 44 by 44 pixels, visible labels on every control, and colour contrast meeting WCAG AA on the dark background. Banners carry text, not colour alone.

## Acceptance criteria

1. `canHandOff` table tests: each blocking reason alone blocks; each clears when its resolution is recorded; an empty list enables the controls; the browser and server builds return the same result for the same input.
2. Every outbound control (Gmail handoff, each copy button, "Copy all", "Open WhatsApp", "Open application link") is disabled while any reason is open; an end-to-end test tries each one.
3. Clicking an enabled handoff calls the share or navigation inside the click handler, with no awaited request before it (tested with a slowed network).
4. "I checked this" clears only its own sentence; editing re-runs `validate` at once; a disputed address clears only when the retyped value passes the strict check; declining a word limit, keyword or subject format clears the flags it caused.
5. Address checks with a fake DNS: an MX record passes; an A or AAAA record with no MX passes; a null MX and an unknown domain block; a DNS timeout warns; free mail warns; a mismatched domain warns but never blocks.
6. Crops and screenshots are served only through signed URLs that expire in 60 seconds; a job with no crop shows the full screenshot with the retype field.
7. The `mailto:` link encodes the address, subject and body; parsing the built link always yields exactly one recipient and no extra header, including for a subject or body containing `&bcc=`, `%0ABcc:` or `%2C`.
8. `wa.me` links use the normalised number and an encoded message; "Open application link" appears only for `https` links.
9. Every waiting state shows its controls, and each control moves the job as the platform's state table allows.
10. Mark sent, Mark submitted, Skip and Mark bounced follow the ledger's state machine; Mark sent records the Gmail answer; the manual-run Stop records route, company and role.
11. The scam banner needs the explicit override before any outbound action.
12. End-to-end test with the fake models: upload a synthetic post, reach the kit, resolve each flag, hand off, mark sent, and see the stats change.
13. An automated accessibility check (axe through Playwright) reports no serious violations on the job page.
