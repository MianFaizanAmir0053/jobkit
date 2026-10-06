# Project Brief: Job Application Assistant

> Architecture sketch the project owner brought from an earlier chat, supplied on 2026-10-06. Content kept as written, with light markdown formatting only; the conversational opening and closing lines are left out.
> This is the source document. Later decisions that refine or override it live in `docs/ideas/`, `SPEC.md` and `docs/decisions/`.

## Core workflow

1. **Input** — screenshot or LinkedIn job URL
2. **Extraction** — pull the job text out (OCR for screenshots, fetch+parse for links)
3. **Structuring** — turn raw text into a clean JSON record: company, role, location, salary, requirements, apply method (email vs form vs LinkedIn Easy Apply), recipient/URL
4. **Matching** — compare requirements against your stored skills/experience, compute a fit score, flag genuine gaps (don't paper over them — this is what's worked well in our emails)
5. **Generation** — LLM drafts the tailored email/answers, honest about gaps, portfolio link included, matching any subject-line or formatting instructions the post specifies
6. **Review gate** — you approve or edit before anything sends (strongly recommend keeping this, explained below)
7. **Delivery** — send email (Gmail API/SMTP with CV attached) or fill a form
8. **Logging** — track company, role, date, status in a database so you never duplicate-apply

## Tech stack

- **Extraction/parsing/generation:** Claude API (vision model reads screenshots directly — no separate OCR needed; text model structures + drafts)
- **Orchestration:** Python (FastAPI) or Node.js backend, or even n8n if you want less custom code
- **Your profile as structured data:** a JSON/YAML file of your skills, projects, achievements, and known gaps — essentially what's in this conversation's memory, formalized
- **Database:** Postgres or SQLite — tables for `jobs`, `applications`, `status`
- **Email sending:** Gmail API (OAuth) or SMTP via nodemailer
- **Form filling:** Playwright for ATS platforms (Greenhouse, Lever, Workday have fairly predictable field structures)
- **Interface:** simplest is a Telegram/WhatsApp bot — forward a screenshot, get back a draft, tap approve or edit

## Where to be careful

- **LinkedIn Easy Apply automation is risky.** Automating actions on LinkedIn (auto-filling, auto-submitting) violates their User Agreement and can get your account restricted or banned. If you want LinkedIn coverage, safer options are: (a) auto-fill the form fields via browser automation but require your manual click to submit, or (b) skip LinkedIn automation entirely and focus the system on email-based applications, which have no such restriction.
- **Keep the human review step, at least initially.** Auto-generated skill claims sent without review is how you end up overstating things to an employer — the gap-flagging behavior in our emails (e.g., "I haven't used Snyk professionally") only works because you're checking facts, not just confirming they sound plausible.
- **Dedup matters** — hash company+role or job text so a reposted listing doesn't trigger a second application.

## Build order (MVP → full)

1. **MVP:** Screenshot in → structured extraction → drafted email → you copy-paste and send manually (this is literally what we've been doing, just not yet scripted)
2. **V2:** Add one-tap send via Gmail API once you trust the drafts
3. **V3:** Add Playwright form-filling for common ATS platforms
4. **V4 (optional, higher risk):** LinkedIn Easy Apply automation, only if you're comfortable with the ToS/ban risk
