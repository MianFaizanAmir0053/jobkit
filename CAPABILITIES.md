# Capability Map: jobkit MVP

Approved by the owner on 2026-10-06, and amended the same day when one-tap send moved to milestone 2 ([ADR 0001](docs/decisions/0001-mvp-decisions.md), amendment A1). Each module has its own spec beside this file, named `SPEC-<module id>.md`; this map is the index of what exists. Module ids are stable and never renamed.

| Module id | Responsibility | Depends on |
|---|---|---|
| `platform` | App skeleton, database schema and migrations, owner sign-in and sessions, QR pairing with laptop approval, the model-call wrapper that logs cost and time per call, the job pipeline runner, keep-alive and daily purges, CI and pre-commit guard. Also holds the project-wide conventions. | — |
| `profile` | Facts YAML schema and validation, seed script, access to approved facts only, fixed answers, gap templates, signature, style examples | platform |
| `intake` | Upload, share target, pasted text, image encoding, storage, job creation, adding screenshots, 30-day purge | platform |
| `ledger` | Application log: statuses, timings, costs, spend cap, duplicate matching, import of earlier applications, interleaved baseline, factual-edit rate and trust-gate counter, 180-day purge | platform |
| `extraction` | Tiling, job record schema, vision extraction, instructions checklist, untrusted-input rules, strict contact checks, contact box and Gemini second read, multi-role pick, form questions, eligibility check | intake, profile |
| `drafting` | Fit table, email, form and message kits, style rules, citations, independent judge and classification, gap coverage, recheck | extraction, profile |
| `review` | Job page: contact panel and address checks, flags, checklist, editor, outbound gate on every exit, Gmail, `wa.me` and copy handoffs, Mark sent with the Gmail question, Submitted, Skip and Bounced | drafting, ledger |
| `evals` | Archive import, labelling page with a blind subset, harness, held-out split, intervals, model comparison, inflation set, aggregate reports | extraction, drafting |
| `send` | **Milestone 2, deferred.** `gmail.send` consent, token encryption, passkey, content-bound approval, attempt recording, undo window, daily cap, MIME message with the CV | review, ledger |

Build order for the MVP: `platform` → `profile`, `intake`, `ledger` → `extraction` → the extraction half of `evals` (assumption 1 is measured before drafting starts) → `drafting` → the rest of `evals` → `review`. `send` waits for milestone 2.
