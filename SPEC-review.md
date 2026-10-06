# Spec: review

- **Module id:** `review` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `drafting`, `ledger`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 9, 11, 13, 15, 16, 18, 28 and 29, the status default, and amendments A1, A4, A5 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** draft for owner approval

## Objective

Put everything the owner must check on one phone screen, refuse every outbound action while a blocking issue stands, and hand the finished kit to Gmail, WhatsApp or the clipboard with as few taps as possible. Stage registered with the platform's runner: `address_checks`, which runs in the `checking` state after `address_read`.

## Jobs list

`/jobs` lists jobs newest first, with company, role, route, state or status, and a progress label while the pipeline runs. Failed jobs show their reason and a Retry button. Opening the list re-triggers stalled jobs (platform B9).

## Job page

`/jobs/<id>`, laid out for a phone, from top to bottom:

1. **Banners**, most serious first:
   - scam warning (red), quoting the signals;
   - likely ineligible (amber), with the reasons and, while the job waits, Draft anyway and Skip;
   - duplicate matches from the ledger, each with its date and reason;
   - unclear eligibility reasons;
   - the spend warning.
2. **Progress** while the pipeline runs: state names and elapsed seconds; on failure, the reason and Retry.
3. **Contact panel** (email and WhatsApp kits): the address or number in large type, the enlarged crop beside it, and the result of the second read. When the reads disagree, a field asks the owner to retype the address or number from the screenshot. Below them, the address checks, each with a plain reason.
4. **Checklist:**
   - every instruction from the post, marked applied, not applied, or "Not followed: addressed to AI";
   - required attachments, each with a tick box;
   - the subject-format toggle, which rebuilds the subject at once.
5. **Fit table:** each requirement with Met, Partial or Gap; tapping a verdict shows the cited facts.
6. **Draft:**
   - email: To, Subject and Body as editable fields, with the signature shown below;
   - form: the cover note and each answer, each with a copy button;
   - message: the message and a copy button.
   
   Flagged sentences are highlighted with their reason, and each offers "I checked this". Tapping a `post` sentence shows the record field it came from.
7. **Actions:** the handoff buttons, the status buttons and Skip.

Images and crops reach the page only through signed URLs that last 60 seconds.

## Stage `address_checks`

Runs for email routes, and again whenever the owner edits the To field.

- **Syntax:** the strict address check (extraction spec). Failure is blocking.
- **Mail host:** MX records for the domain. With no MX, an A or AAAA record counts as the implicit MX of RFC 5321. A null MX (a single MX record pointing to ".", RFC 7505) or no records at all is blocking. A DNS timeout (3 seconds) gives "Couldn't check the mail server", a warning.
- **Free-mail domain** (gmail.com, googlemail.com, yahoo.*, outlook.com, hotmail.*, live.com, icloud.com, proton.me, protonmail.com, aol.com, gmx.*, yandex.*, mail.com, rediffmail.com): warning, "A personal address, not a company one."
- **Company mismatch:** the registrable domain's label (`tldts`) compared with the normalised company name, ignoring hyphens and words such as "careers", "jobs", "hr" and "recruitment". No overlap gives a warning, never a block, because agencies and parent companies are common.

There is no domain-age check (amendment A5).

## The outbound gate

`canHandOff(job)` is one pure function. Every outbound action uses it: the Gmail handoff buttons, every copy button, "Copy all", "Open WhatsApp" and "Open application link". It returns the open blocking reasons:

- an unresolved flag from drafting (`invalid_citation`, `missing_gap_line`, `over_limit`, `keyword_missing`, `ai_instruction_followed`, or an `overstated` or `unsupported` sentence without "I checked this");
- a changed sentence from `recheck` awaiting confirmation;
- a required attachment without its tick;
- a disputed address or number not yet retyped by the owner;
- a blocking address check;
- a `company-role` or `drafted` duplicate without "apply again";
- a scam signal without the explicit "Continue anyway" override;
- an eligibility decision still pending.

While the list is not empty, those buttons stay disabled and the reasons are listed above them. Just before any outbound action, the page sends the final text to `recheck`; a new flag stops the action.

## Handoffs

- **Email.** Two mechanisms are built for the day-X spike, and the one that takes fewer taps on the owner's phone stays:
  - **A:** "Open in Gmail" follows a `mailto:` link. Code builds it: the address after the strict check, then `subject` and `body` each encoded with `encodeURIComponent`, so nothing in a post can add a header or a recipient. The owner attaches the CV in Gmail; the job page offers the CV for download once, after which it sits among Gmail's recent files.
  - **B:** "Share with CV" copies the address and subject to the clipboard, then calls the Web Share API with the CV file and the body text. It is shown only where file sharing is supported.
  
  The page reminds the owner to check that Gmail's From shows `faizanamir0053@gmail.com`, and to make any change in jobkit rather than in Gmail. After the handoff it asks "Did you send it?" with Mark sent and Not yet. Mark sent then asks "Did you change anything in Gmail?" (Yes or No), and the ledger records the outcome.
- **Form.** Copy buttons per field, "Copy all" (cover note and answers as labelled plain text), "Open application link" when the record has one, and Mark submitted.
- **Message.**
  - WhatsApp: "Open WhatsApp" builds `https://wa.me/<number>?text=<message>` from the normalised number (extraction spec), with the message encoded.
  - LinkedIn: copy only. The owner posts the message or comment.
  
  Then Mark submitted.
- **Always available:** Skip; and on sent jobs, Mark bounced.

## Look

Neutral shadcn components on the dark theme with the lime accent (platform A2). Touch targets at least 44 by 44 pixels, visible labels on every control, and colour contrast meeting WCAG AA on the dark background. Banners carry text, not colour alone.

## Acceptance criteria

1. `canHandOff` table tests: each blocking reason alone blocks; each clears when its resolution is recorded; an empty list enables the buttons.
2. Every outbound control (Gmail handoff, each copy button, "Copy all", "Open WhatsApp", "Open application link") is disabled while `canHandOff` reports a reason; an end-to-end test tries each one.
3. "I checked this" clears only its own sentence; editing the text runs `recheck` again; a disputed address clears only when the owner's retyped value passes the strict check.
4. Address checks with a fake DNS: an MX record passes; an A or AAAA record with no MX passes; a null MX and an unknown domain block; a DNS timeout warns; free mail warns; a mismatched domain warns but never blocks.
5. Crops and screenshots are served only through signed URLs that expire in 60 seconds.
6. The `mailto:` link encodes subject and body, including non-ASCII text and line breaks; a subject or body containing `&bcc=` or `%0ABcc:` cannot add a recipient or header (tested by parsing the built link).
7. `wa.me` links use the normalised number and an encoded message.
8. Mark sent, Mark submitted, Skip and Mark bounced follow the ledger's state machine; Mark sent records the Gmail answer.
9. The scam banner needs the explicit override before any outbound action.
10. End-to-end test with the fake models: upload a synthetic post, reach the kit, resolve each flag, hand off, mark sent, and see the stats change.
11. An automated accessibility check (axe through Playwright) reports no serious violations on the job page.
