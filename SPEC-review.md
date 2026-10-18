# Spec: review

- **Module id:** `review` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `drafting`, `ledger`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 9, 11, 13, 15, 16, 18, 21, 28 and 29, the status default, and amendments A1, A4, A5, A8, A11, A20, A21 and A22
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A; job states from platform B9
- **Status:** approved by the owner on 2026-10-06, after two review cycles

## Objective

Put everything the owner must check on one phone screen, refuse every outbound action while a blocking issue stands, and hand the finished kit to Gmail, WhatsApp or the clipboard with as few taps as possible. Stage registered with the platform's runner: `address_checks`, which runs in the `drafting` group beside `templates` or `draft`, and `address_read`.

## Jobs list

`/jobs` lists jobs newest first, with company, role, route, state or status, and a progress label while the pipeline runs. Failed jobs show their reason, Retry and Skip; jobs in `upload_failed` show "Upload again" and Skip. A failed job whose kit's send may have gone, as when a Gemini draft asked for beside the kit failed, or that can go back to the templates' drafts, is skipped from its page, which warns of the send or offers the drafts first; the list says so in place of Skip, with a link to the job. The list's Skip names the job's state and when it reached it, and its confirmation and buttons name the job, by its title and when it came in, the title put on one line of bounded length, since the post's author wrote it. Opening the list resumes running jobs, and the list polls only while some job is running (platform B9).

## Job page

`/jobs/<id>`, laid out for a phone. What it shows depends on the job's state.

**Waiting and special states:**

- `manual_run`: "This one is a manual run: apply the old way, then tap Stop", a running stopwatch, and Stop, which asks for route, company and role (ledger spec).
- `needs_role_pick`: the roles with title, location and route, and Skip.
- `needs_eligibility_decision`: the reasons, with Draft anyway and Skip.
- `needs_kit_type`: email, form or message, and Skip.
- `stopped`: the reason. For "not a job post", the button "This is a job post" sends it back to extraction.
- `failed`: the stage, a readable reason, Retry and Skip; when a Gemini draft the owner asked for beside the templates' failed, "Back to your drafts" first (decisions A22).
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
   - the drafts (decisions A21 and A22), when there are several or Gemini can write one: each with whose words it holds (one of the owner's templates, or Gemini's), the share of the must-haves it covers, what it has to check and its length, best first, the first marked Recommended. The one shown is the kit, the owner's pick or else the Recommended one, and "Show this one" picks another; decisions on sentences and flags count for the draft they were made on, and come back when the owner picks it again, while those on the post go with the pick. On a kit only the templates drafted, "Write a draft with Gemini too" keeps the draft shown as the pick and runs drafting again, in a new round of attempts; Gemini's draft, once judged in that round, then ranks among them. A Gemini draft from an earlier reading of the post, or one its check never weighed, is not offered;
   - email: To and Subject as fields, and the body as a list of blocks, each editable on its own, with buttons to add or delete a block. A note says the Gmail app adds the owner's Gmail signature;
   - form: the cover note as blocks, and each answer with a copy button; topic answers marked "from your profile"; a question only one classifier tied to a topic offers "Use my profile answer" or "Draft it"; "Needs your answer" fields where the question or the profile lacks what the answer needs;
   - message: the message as blocks, and a copy button.
   
   Flagged blocks are highlighted with their reason. Each flagged block offers "I checked this"; each drafted short answer offers a tick; a gap without a usable line shows "Needs your line"; a block the owner wrote can be marked as answering a requirement.
6. **Actions:** the handoff buttons, the status buttons and Skip.

Images and crops reach the page only through signed URLs that last 60 seconds.

## Stage `address_checks`

Runs for email routes in the `drafting` group, and again whenever the owner edits the To field. A result is kept with its input (the address, the company and the checks' version), so the same address is not looked up again. Checks made for another address than the one that stands, or missing once the second read ran, block as not checked; so do checks kept from an older, stricter rule that stopped at the strict check, for an address that now passes it, since the checks after it never ran. The test server's DNS gives every domain a mail host, so end-to-end tests run offline.

- **Syntax:** the strict address check (extraction spec). Failure is blocking.
- **Mail host:** MX records for the domain. With no MX, an A or AAAA record counts as the implicit MX of RFC 5321. A null MX (a single MX record pointing to ".", RFC 7505) or no records at all is blocking. A DNS timeout (3 seconds) gives "Couldn't check the mail server", a warning.
- **Free-mail domain** (gmail.com, googlemail.com, yahoo.*, outlook.com, hotmail.*, live.com, icloud.com, proton.me, protonmail.com, aol.com, gmx.*, yandex.*, mail.com, rediffmail.com): warning, "A personal address, not a company one."
- **Company mismatch:** the registrable domain's label (`tldts`) compared with the normalised company name, ignoring hyphens and words such as "careers", "jobs", "hr" and "recruitment". No overlap gives a warning, never a block, because agencies and parent companies are common; a domain made only of such words ("careers-hiring.com") names no company and warns too.

There is no domain-age check (amendment A5).

## The outbound gate

`canHandOff(job, kit)` is one pure function, bundled for the browser and run on the server too. Every outbound control uses it: "Approve & send", the Gmail handoff buttons, every copy button, "Copy all", "Open WhatsApp" and "Open application link". It returns the open blocking reasons:

- any flag from drafting's `validate` that is unresolved, including `overstated`, `unsupported` and `company_claim` sentences without "I checked this", unticked short answers, and "Needs your answer" fields;
- a changed sentence awaiting the owner's confirmation;
- a required attachment without its tick;
- a disputed or missing address or number not yet retyped by the owner;
- a blocking address check;
- a duplicate match (any reason) without "apply again";
- a scam signal without the explicit "Continue anyway" override.

The owner's decisions on a kit, the sentences and flags marked "I checked this", the address or number they typed, the attachments ticked, the requirements they say they meet and "Continue anyway", are kept as one `kit_reviews` row per job and role, with the gate's open reasons as the server last found them (the owner's choice, 2026-10-14); "apply again" stays on the application, where the ledger keeps it. Each decision is checked against what the kit holds, two made at once are both kept, and a decision counts only for the kit it was made on, so a redraft or a new reading clears it. When a typed address or number clears the contact, the handoff uses it, and an address the owner types gets the address checks itself, which then stand in for the post's. Until declining a format and the block editor exist, each flag from `validate` clears with its own "I checked this"; a requirement only the owner can confirm they meet takes "I meet this requirement", their word, kept by the requirement and going with a draft pick, or else "I will fix it in Gmail", for an owner who does not meet it and takes the email's claim out there, which a must-have's gap line then answers; Approve & send settles neither (Claude's choices, 2026-10-18, after the fit table's reviews); the CV needs no tick, since the page says to attach it in Gmail, and any other required attachment is ticked as a promise to attach it there; a kit marked sent holds every outbound control (Claude's choices, 2026-10-14, after the gate's first review; the owner can change them), and so does one jobkit is sending, from the press of Send until it went, failed or the owner pressed Undo (decisions A20), and one the owner skipped, until the skip is taken back; no decision is made on a sent or skipped kit.

The page runs `validate` and `canHandOff` in the browser on every edit, so the controls enable or disable at once with the reasons listed above them. The server runs the same functions on the same text, debounced, and records the result; a control enables only when both agree. Until the block editor exists, the page draws the gate the server found, and its outbound controls ask the server again when they are drawn, whenever the page is shown again and every 15 seconds while it is shown, opening only while the server says the gate is open for the kit the page shows and the address it goes to, and agrees on the status of the role's application; the answer is forgotten the moment the page is hidden or a decision from it is in flight, and the job's other tabs in the browser are told of a decision at once. A decision names that kit, and one made on another is refused. Mark sent is offered only while the gate is open and names the kit and address the page showed, refused for any other; a mistaken one can be taken back, by the tap the page showed. Clicking a control never waits for the server first: the handoff happens inside the click, which Android needs for the share sheet, and the final text and outcome are posted right after.

## Handoffs

- **Email: Approve & send** (decisions A20; [SPEC-send.md](SPEC-send.md)). Once Gmail is connected, the email kit's first control sends it from the owner's Gmail with the profile's signature and CV. One press opens a confirmation in its place, with From, To, the subject, the CV's file name and the flagged sentences and flags the press marks "I checked this"; Send then counts down ten seconds with Undo, and the page shows how it went. The hard stops hold the button: an address not confirmed, a blocking address check, a possible repeat and a scam warning, each listed above it. A post that asks for a file besides the CV is sent from Gmail, where the owner attaches it, and so is a kit whose words must change first: a line the owner must write, a placeholder in the subject, a reference's details or a line written for an AI tool (decisions A22). An email jobkit sent is marked sent, and its Mark sent cannot be taken back. The handoffs below stay as the way to send it yourself.
- **Email, sent by the owner.** Two mechanisms are built for the tap-count spike, and the one that takes fewer taps on the owner's phone stays:
  - **A:** "Open in Gmail" follows a `mailto:` link built by code: the address after the strict check, then `subject` and `body`, each part encoded with `encodeURIComponent`, so nothing in a post can add a header or a recipient. The owner attaches the CV in Gmail; the job page offers the CV for download once, after which it sits among Gmail's recent files.
  - **B:** "Share with CV" copies the address and subject to the clipboard, then calls the Web Share API with the CV file and the body text. It is shown only where file sharing is supported.
  
  The page reminds the owner to check that Gmail's From shows `faizanamir0053@gmail.com`, and to make changes in jobkit rather than in Gmail. Until the block editor exists (Task 29), it says instead that a change to the email's wording in Gmail is answered Yes when asked, and that attaching the CV does not count (the owner's decision, 2026-10-12). Afterwards it asks "Did you send it?" with Mark sent and Not yet. Mark sent then asks "Did you change anything in Gmail?" (Yes or No), and the ledger records the outcome.
- **Form.** Copy buttons per field, "Copy all" (cover note and answers as labelled plain text), and "Open application link" only for an `https` link (any other link is shown as text with a warning). Then Mark submitted.
- **Message.**
  - WhatsApp: "Open WhatsApp" builds `https://wa.me/<number>?text=<message>` from the normalised number (extraction spec), with the message encoded.
  - LinkedIn: copy only. The owner posts the message or comment.
  
  Then Mark submitted.
- **Always available:** Skip; and on sent jobs, Mark bounced. Skip on a ready kit skips its application alone (ledger spec, "Statuses"): the job and its kit stay, every outbound control holds with "You skipped this job, so nothing goes out from this page. Take the skip back to apply.", the page says when it was skipped, and "Take back the skip" opens the kit again; the job page and the jobs list show the job as Skipped. Skip names the kit the page showed, and a state's Skip the state it showed and when the job reached it, so a Skip that arrives after the job moved on, or from a page that names neither, is refused rather than taken for the other kind: a kit's Skip never closes a job. A kit marked sent cannot be skipped, since it went, nor one jobkit is sending, until Undo stops it or the send ends; one whose send may have gone is skipped only from a page that warned of it, and if Gmail sends it after all, it is marked sent over the skip, at the address it went to. So is a job closed whose kit's send may have gone, as when a Gemini draft asked for beside it failed: its page warns of the send, and Skip there closes the job for good. A kit the page can no longer read can be skipped too, while its post can still be read: one whose post cannot be read names no role, so it offers no Skip, and the owner sends the post again as a new job. A page showing the kit on the other device learns of a skip or a bounce, or of the taking back of either, at its next gate check, 15 seconds at most, and is drawn again; one that can no longer read its kit shows it once drawn again. While skipped, the panel after the send is titled "Not applying", and nothing on the page says to send the email again. A skip that closed its job is not taken back. Mark bounced, on an email marked sent, names the Mark sent the page showed, so a tap from a page drawn before that Mark sent was taken back and made again is refused: the application moves to bounced, the kit stays held as sent, the page says when it was marked bounced, with "Take back Mark bounced", by the bounce it shows, and the job page and the jobs list show the job as Bounced; a kit the page can no longer read offers them too. A Mark sent is taken back only once its bounce is, and then by its own time, as the page showed it. An earlier application whose email bounced reads, on the duplicate banner, as sent with jobkit and bounced, and Apply again past it holds the kit no longer: should that bounce be taken back, the kit is held again until the owner applies again past the match as it now reads.

## Look

Neutral shadcn components on the dark theme with the lime accent (platform A2). Touch targets at least 44 by 44 pixels, visible labels on every control, and colour contrast meeting WCAG AA on the dark background. Banners carry text, not colour alone.

## Acceptance criteria

1. `canHandOff` table tests: each blocking reason alone blocks; each clears when its resolution is recorded; an empty list enables the controls; the browser and server builds return the same result for the same input.
2. Every outbound control (Gmail handoff, each copy button, "Copy all", "Open WhatsApp", "Open application link") is disabled while any reason is open; an end-to-end test tries each one. "Approve & send" is disabled while a reason it does not settle is open, and the server refuses a press the gate holds.
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
14. Drafts (decisions A21 and A22): a kit the templates drafted shows their drafts best first with the first shown and nothing for a separate check to hold; picking another makes it the kit, its own sentence and flag decisions apart and restored on picking it again, the typed address carried; a pick from a page drawn on another kit, of a draft the kit lacks, or while it sends, is refused; "Write a draft with Gemini too" ranks Gemini's draft among them and keeps the kit shown and its decisions though Gemini's ranks first, and earlier failures never fail it at once; "Back to your drafts" after it fails, or after its check fails, makes the kit ready again with the templates' drafts alone; a Gemini draft from an earlier reading of the post is not offered; a kit drafted before the templates keeps its key; the email's outcome records which draft went.
