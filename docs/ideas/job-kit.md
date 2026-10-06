# Job Kit

## Problem Statement

How might we turn a job post spotted on the phone into an honest, tailored application ready to send in under two minutes, without ever sending a claim the owner has not checked?

## Recommended Direction

A standalone personal tool, also built as a portfolio case study. The owner shares a job post from their Android phone: one or more screenshots, pasted text, or a link to a public Greenhouse, Lever or Ashby posting. A vision model turns it into a structured record: company, role, location, salary, requirements, the application route (email, ATS form, LinkedIn Easy Apply, careers page or other), the address or link, and the instructions the post gives applicants, such as a subject line format, required attachments or questions to answer. The record is matched against the owner's profile, a list of facts that each carry an ID and a source, into a table that marks each requirement Met, Partial or Gap.

The tool returns an application kit for the route the post asks for. For email, it drafts To, Subject and Body with the CV attached; the owner edits the draft and sends it with one tap. Code, never a model, sends it through the Gmail API after three checks: the address's domain has mail servers, the domain fits the company, and no earlier application matches. For the other routes, the kit holds a cover note and answers ready to copy, plus the link, and the owner submits the form themselves. Every claim in a draft cites a profile fact. A sentence with no fact behind it is flagged before the send button appears, and gaps are stated plainly in the owner's own words.

The phone reaches the tool through the tool's own web app, paired once by scanning a QR code shown on the laptop, the way WhatsApp Web links a computer. Each application is logged with the Gmail thread ID of the email sent, so a later module, or mailagent, which already reads the owner's mail, can track replies.

## Key Assumptions to Validate

- [ ] The vision model reads the address, company and role correctly on at least 95% of the owner's real screenshots. Label 20 to 30 past screenshots and measure before building the rest.
- [ ] Drafts need only light edits. Measure how much the owner changes between draft and sent email over the first 20 real uses.
- [ ] The claim check catches overstatement. Build a set of posts asking for skills the owner lacks and count what slips through.
- [ ] Email sent through the Gmail API from the owner's personal account lands in the inbox, not spam. Send to a second address and a mail-testing service.
- [ ] The phone can reach the tool when needed. Depends on hosting; test on mobile data, away from home Wi-Fi.

## MVP Scope

In:

- input as screenshots, pasted text or a public ATS link;
- extraction to a structured record, including the post's instructions to applicants;
- the profile as facts with IDs and sources, and per-requirement fit;
- a kit for every route, with the claim check;
- the QR-paired phone web app, with editing;
- one-tap Gmail send with the CV, after the three checks;
- an application log with duplicate detection and the Gmail thread ID;
- an evaluation set built from past applications, reporting extraction accuracy, unsupported claims, edit size, time from share to send, and cost per application.

Out: everything below.

## Not Doing (and Why)

- **LinkedIn Easy Apply automation.** It breaks LinkedIn's User Agreement and risks the owner's account. The kit covers Easy Apply by copy and paste.
- **Fetching LinkedIn links.** Scripted fetching counts as scraping under the same agreement. LinkedIn links are stored as references only.
- **Playwright form filling.** A phone user cannot watch or submit a browser running elsewhere, and Workday needs an account per company. Copy-ready answers give most of the speed.
- **Telegram.** Blocked on the owner's network.
- **WhatsApp.** The Business API needs Meta setup and a separate number, and sits in a grey area under Meta's January 2026 rule against AI-provider bots. Unofficial WhatsApp libraries break WhatsApp's terms and risk a ban.
- **Sending without review.** Unchecked claims to employers are the failure this tool exists to prevent.
- **Job-alert inbox.** Alert emails carry title, company and link only, so a draft still needs the full post. A candidate for later.
- **Follow-ups and reply tracking.** They raise the reply rate, not the speed per job. The logged thread IDs make them cheap to add later.
- **Merging into mailagent.** Keeps both case studies focused and this one quick to ship. The thread-ID seam keeps the door open.
- **Other users.** One owner: no accounts, billing or Google verification for strangers.

## Open Questions

- Model provider: Claude, as the brief proposes, or Gemini, as mailagent uses? Is a Claude API key with credit available?
- Hosting: the laptop with a tunnel (free, but the laptop must be on) or a free cloud host?
- Language: Python, so mailagent's Gmail code can be copied, or TypeScript?
- Profile: who writes the facts and gap lines, and from which sources (CV, portfolio case studies)?
- Does an archive of past screenshots and sent emails exist to seed the evaluation set?
- One CV, or a variant per role type?
