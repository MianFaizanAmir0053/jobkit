# Spec: profile

- **Module id:** `profile` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `platform`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 5, 6, 8, 15, 21 and 22
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** draft for owner approval

## Objective

Hold everything the drafts may say about the owner, and nothing the owner has not approved: facts with IDs and sources, gap templates and known gap lines, fixed answers to legal and practical questions, the signature, the CV and the style examples. Other modules read the profile only through this module, which hands out approved items only.

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
signature: |
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
    kind: experience        # skill | experience | project | metric | education | language | other
    skills: [nextjs, react, typescript]
    depth: production       # production | professional | side-project | learning
    years: 4                # optional
    source: "resume.pdf, page 1; Portfolio projects.ts: carder, volumize"
    approved: true
gaps:
  templates:
    - id: G-not-professional
      text: "I haven't used {skill} professionally; the closest is {related}."
    - id: G-learning
      text: "I'm new to {skill}; I have been working through it in {related}."
  known:
    - id: K-kubernetes
      skills: [kubernetes, k8s]
      line: "I haven't run Kubernetes in production; I deploy containers on Fly.io and Vercel."
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
  timezone_overlap: "..."
  relocation: "..."
  work_authorisation:       # one entry per region the owner may meet in posts
    - { region: PK, authorised: true }
    - { region: US, authorised: false, sponsorship_needed: true, note: "..." }
    - { region: UK, authorised: false, sponsorship_needed: true, note: "..." }
    - { region: EU, authorised: false, sponsorship_needed: true, note: "..." }
    - { region: AE, authorised: false, sponsorship_needed: true, note: "..." }
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

- **Fact IDs** match `F-[a-z0-9-]+`, known-gap IDs `K-[a-z0-9-]+`, template IDs `G-[a-z0-9-]+`. IDs are unique and never reused for a different statement; changing a statement's meaning means a new ID.
- **Depth** is what the judge uses to catch inflation: a `side-project` fact cannot support "production experience", and `years` bounds any claim about duration.
- **Templates** use only the placeholders `{skill}` and `{related}`. `{related}` is filled with a cited approved fact, never with free text.

## Drafting the first version

Writing the first profile is a build task, not a product feature. During the build, Claude Code drafts `private/profile.yaml` from `Portfolio/public/resume.pdf` and `Portfolio/src/data/projects.ts`, with every fact set to `approved: false` and its source filled in. The owner reads each fact, edits it or deletes it, and sets `approved: true`. The owner writes the gap templates, the known gap lines, the fixed answers and the signature, and picks the style examples. No runtime code drafts facts.

## Seeding

`npm run profile:seed` reads `private/profile.yaml` and:

1. validates it against the strict schema and reports every error with its line number;
2. checks that IDs are unique and well formed, every fact has a source, the signature is present, the CV file exists, is a PDF and is at most 5 MB, and there are 3 to 5 style example files, each at most 2,000 words;
3. computes the SHA-256 of the file plus the CV and style files; if a profile version with that hash already exists, stops without changes;
4. uploads the CV to storage at `profile/cv-<sha256>.pdf` when that object does not exist yet;
5. inserts a `profile_versions` row holding the validated document, its hash, the CV storage path and label, and the time, and marks it active.

Versions are immutable. Drafts store the profile version they used, so their citations still resolve after the profile changes.

## Access API

`getActiveProfile(db)` returns one object:

- `versionId`, `owner`, `links`, `signature`, `cv` (storage path and label);
- `facts`: approved facts only;
- `gapTemplates`, and `knownGaps`: approved lines only;
- `fixedAnswers`;
- `styleExamples`: the texts.

`getProfileVersion(db, versionId)` returns the same shape for an older version, for citation lookups and evaluation runs. Unapproved items stay in the stored document but never leave this module.

## Profile page

A read-only page shows the active version's date and hash prefix, counts of approved and waiting items, approved facts grouped by kind with their sources, gap templates and known gap lines, fixed answers and the signature. It tells the owner to edit the YAML file and run the seed to change anything.

## Public sample

`evals/synthetic/profile.sample.yaml` describes a fictional person and passes the same schema. CI validates it, and the tests and the public demo use it. The real profile never enters the repository.

## Acceptance criteria

1. The seed rejects, with line numbers: unknown keys, a duplicate or malformed ID, a fact without a source, a missing signature, a missing or oversized CV, a CV that is not a PDF, and fewer than 3 or more than 5 style examples.
2. Seeding an unchanged profile creates no new version.
3. `getActiveProfile` never returns an unapproved fact or gap line (tested with a mixed file).
4. An older version stays retrievable by ID after a new one is seeded.
5. The CV is uploaded once per content hash, and the label is returned with the profile.
6. The public sample profile passes validation in CI.
7. The Profile page shows the version date and the approved and waiting counts, and offers no editing.
