# Spec: profile

- **Module id:** `profile` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `platform`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 5, 6, 8, 15, 18, 21 and 22, and amendments A11 and A21
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** approved by the owner on 2026-10-06, after two review cycles

## Objective

Hold everything the drafts may say about the owner, and nothing the owner has not approved: facts with IDs and sources, gap templates and known gap lines, email templates, fixed answers to legal and practical questions, the signature, the CV and the style examples. Other modules read the profile only through this module, which hands out approved items only.

## The profile file

The owner edits `private/profile.yaml` on the laptop. The schema is strict: unknown keys are errors.

```yaml
schema: 1
owner:
  name: Faizan Amir
  email: faizanamir0053@gmail.com
  location: { city: Lahore, country: PK, timezone: Asia/Karachi }
links:
  portfolio: https://faizan-dev.vercel.app
  linkedin: https://www.linkedin.com/in/...
  github: https://github.com/...
signature: |                # message kits; also what the owner sets as Gmail's mobile signature
  Faizan Amir
  Portfolio: https://faizan-dev.vercel.app
  LinkedIn: ...
  GitHub: ...
  WhatsApp: ...
cv:
  file: cv.pdf              # relative to private/
  label: "2026-10"          # logged with every application
facts:
  - id: F-nextjs-production
    statement: "Shipped production Next.js applications since 2022, including Carder and Volumize."
    phrase: "four years shipping production Next.js apps"   # fills {related} in gap templates
    kind: experience        # skill | experience | project | metric | education | language | other
    skills: [nextjs, react, typescript]                    # from the shared skill vocabulary
    depth: production       # production | professional | side-project | learning
    years: 4                # optional
    source: "resume.pdf, page 1; Portfolio projects.ts: carder, volumize"
    approved: true
gaps:
  templates:
    - id: G-not-professional
      text: "I haven't used {skill} professionally; the closest is {related}."
    - id: G-learning
      text: "I'm new to {skill}; I have been working towards it through {related}."
  known:
    - id: K-kubernetes
      skills: [kubernetes]
      line: "I haven't run Kubernetes in production; I deploy containers on Fly.io and Vercel."
      approved: true
email_templates:            # optional (amendment A21): bodies for kinds of role
  - id: T-full-stack
    name: Full-stack engineer
    skills: [nextjs, react]   # what its words show, each from a fact it cites
    sentences:
      - text: "I'm writing about the {role} role at {company}."
        kind: post            # claim | post | courtesy
        paragraph_break: true
      - text: "I have shipped production Next.js applications since 2022, including Carder and Volumize."
        kind: claim
        facts: [F-nextjs-production]
        paragraph_break: true
      - text: "I'd be glad to talk about how I could help."
        kind: courtesy
    approved: true
fixed_answers:
  salary_expectation:       # text per currency; drafts never invent a figure
    USD: "..."
    GBP: "..."
    EUR: "..."
    AED: "..."
    PKR: "..."
  notice_period: "..."
  availability: "..."
  working_window: { start_utc: "04:00", end_utc: "13:00", text: "..." }
  relocation: { open: true, places: [AE, SA, QA], text: "..." }
  work_authorisation:       # one entry per country or region; anything unlisted counts as unknown
    - { place: PK, authorised: true }
    - { place: US, authorised: false, sponsorship_needed: true, text: "..." }
    - { place: GB, authorised: false, sponsorship_needed: true, text: "..." }
    - { place: EU, authorised: false, sponsorship_needed: true, text: "..." }
    - { place: AE, authorised: false, sponsorship_needed: true, text: "..." }
  years_per_stack: { typescript: 4, python: 3 }
  eeo:
    gender: "Prefer not to say"
    ethnicity: "Prefer not to say"
    veteran: "Not applicable"
    disability: "Prefer not to say"
style_examples:             # 3 to 5 of the owner's best past emails, as plain text
  - style/2026-09-acme.txt
  - style/2026-09-globex.txt
  - style/2026-08-initech.txt
```

- **IDs:** fact IDs match `F-[a-z0-9-]+`, known-gap IDs `K-[a-z0-9-]+`, gap template IDs `G-[a-z0-9-]+`, email template IDs `T-[a-z0-9-]+`. IDs are unique and never reused for a different statement; changing a statement's meaning means a new ID.
- **Skills** come from the shared skill vocabulary (extraction spec); an unknown tag is a seed error, so fit checks compare like with like.
- **Depth and years** are what the judge and the fit check use to catch inflation: a `side-project` fact cannot support "production experience", and `years` bounds any claim about duration.
- **Phrases** are short noun phrases the owner approves with the fact. Code puts them into `{related}`; the model never writes that part of a gap line.
- **Templates** use only the placeholders `{skill}` and `{related}`.
- **Email templates** (amendment A21) are email bodies for kinds of role, full-stack, AI, backend, frontend and a general one, drafted by Claude Code and approved by the owner as facts are. Each is a list of sentences, and each sentence is one kind, as a kit block's class is (drafting spec): a `claim` rests on the facts it cites, at least one, and names nothing from the post; a `post` sentence names the post's `{company}` or `{role}` and nothing more, citing no fact; a `courtesy` sentence does neither. `paragraph_break` starts a new paragraph after a sentence. A template's `skills` are the ones its words show, each from a fact it cites, none for a general one; drafting weighs a role's must-haves against them, not against everything its facts are tagged with. A template has at most 120 words, a placeholder a word, which leaves 60 for the gap lines and the post's names; a draft built from it is still held to the email's limit, and the post's own, when it is built. An approved template cites approved facts only, so a draft built from it needs no separate check of its sentences: the owner's approval is that check, so each sentence must say no more than the facts it cites state. A template makes at least one claim. Its post and courtesy sentences go to every company, so they name the company and the role and nothing more, or are courtesy: the owner's approval is their only check. Drafting builds emails from templates in its `templates` stage (drafting spec, decisions A22): it uses a template only when the post gives every placeholder it uses a value, and puts the gap lines in a paragraph of their own before a closing paragraph of courtesy sentences, or at the end.
- **Fixed answers** are structured where code decides with them: the working window (for time-zone checks), relocation (for onsite roles), and work authorisation (for eligibility). Every place is a code from the shared region table (extraction spec), which the seed checks, so a post's "UK" or "Germany" meets this file's `GB` or `EU`. A place or currency the file does not cover is unknown: eligibility reports it as unclear, and a form question about it shows "Needs your answer".
- **Signature:** message kits end with it. The Gmail app adds the owner's own Gmail signature to handoff drafts, so the runbook has the owner set Gmail's mobile signature to this text once.

## Drafting the first version

Writing the first profile is a build task, not a product feature. During the build, Claude Code drafts `private/profile.yaml` from `Portfolio/public/resume.pdf` and `Portfolio/src/data/projects.ts`, with every fact set to `approved: false` and its source and phrase filled in. The owner reads each fact, edits it or deletes it, and sets `approved: true`. Claude Code drafts the email templates the same way, from approved facts only, each set to `approved: false` for the owner to read, edit and approve (amendment A21). The owner writes the gap templates, the known gap lines, the fixed answers and the signature, and picks the style examples. No runtime code drafts facts.

## Seeding

`npm run profile:seed` reads `private/profile.yaml` and:

1. validates it against the strict schema and reports every error with its line number;
2. checks that IDs are unique and well formed, every fact has a source and a phrase, every email template's sentences keep to their kinds and placeholders and hold no ID from the file, its facts are in the file, an approved one's only approved facts, its skills come from its facts, it makes at least one claim, and it keeps to its 120 words, every skill is in the skill vocabulary, every place is in the region table, the signature is present, the CV file exists, is a PDF and is at most 5 MB, and there are 3 to 5 style example files with at most 1,500 words in total;
3. computes the SHA-256 of the file plus the CV and style files. If a version with that hash already exists, it makes that version active again (which is how the owner rolls back) and stops;
4. otherwise uploads the CV to storage at `profile/cv-<sha256>.pdf` when that object does not exist yet;
5. inserts a `profile_versions` row holding the validated document, its hash, the CV storage path and label, and the time, and marks it active.

Versions are immutable. Drafts store the profile version they used, so their citations still resolve after the profile changes.

## Access API

`getActiveProfile(db)` returns one object:

- `versionId`, `owner`, `links`, `signature`, `cv` (storage path and label);
- `facts`: approved facts only;
- `gapTemplates`, and `knownGaps`: approved lines only;
- `emailTemplates`: approved templates only, none for a version from before them;
- `fixedAnswers`;
- `styleExamples`: the texts.

`getProfileVersion(db, versionId)` returns the same shape for an older version, for citation lookups and evaluation runs. Unapproved items stay in the stored document but never leave this module.

## Profile page

A read-only page shows the active version's date and hash prefix, counts of approved and waiting items, approved facts grouped by kind with their sources, gap templates and known gap lines, approved email templates, fixed answers and the signature. It tells the owner to edit the YAML file and run the seed to change anything.

## Public sample

`evals/synthetic/profile.sample.yaml` describes a fictional person and passes the same schema. CI validates it, and the tests and the public demo use it. The real profile never enters the repository.

## Acceptance criteria

1. The seed rejects, with line numbers: unknown keys; a duplicate or malformed ID; a fact without a source or phrase; an email template sentence that does not keep to its kind (a claim without a fact, a post sentence without a placeholder, a courtesy sentence with either), uses another placeholder or holds an ID, and a template that cites a fact the file lacks, or, approved, one waiting, names a skill no fact it cites shows, makes no claim, or runs past 120 words; a skill outside the vocabulary; a place outside the region table; a missing signature; a missing or oversized CV, or one that is not a PDF; fewer than 3 or more than 5 style examples, or more than 1,500 words in total.
2. Seeding an unchanged profile creates no new version; seeding an older file makes its existing version active again.
3. `getActiveProfile` never returns an unapproved fact, gap line or email template (tested with a mixed file).
4. An older version stays retrievable by ID after a new one is seeded.
5. The CV is uploaded once per content hash, and the label is returned with the profile.
6. The public sample profile passes validation in CI.
7. The Profile page shows the version date and the approved and waiting counts, and offers no editing.
