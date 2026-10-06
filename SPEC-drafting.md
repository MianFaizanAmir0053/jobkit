# Spec: drafting

- **Module id:** `drafting` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `extraction`, `profile`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 8, 9, 12, 15, 20, 21 and 28, and amendment A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** draft for owner approval

## Objective

Write the kit for the route the post asks for, so that every statement about the owner traces to an approved fact, every statement about the company traces to the post, every must-have gap gets an honest line, and nothing the post's author typed acts as an instruction. Then have a separate call classify and check every sentence. Stages registered with the platform's runner: `draft` and `judge`. The module also offers `recheck`, which the review module calls on the owner's final text.

## Kit type

| Route | Kit |
|---|---|
| `email` | email kit |
| `ats_form`, `easy_apply`, `careers_page` | form kit |
| `whatsapp`, `linkedin_dm`, `linkedin_comment` | message kit |
| `other`, `unknown` | the owner picks on the job page |

## Draft structure

Every piece of prose is a list of sentences, and every drafted form answer counts as one sentence, however short ("Yes", "5 years"). Each sentence has an ID (`S1`, …), its text, the drafter's proposed class, and references:

- `claim`: says something about the owner; cites one or more fact IDs;
- `post`: says something about the company or the role; cites the record field it comes from (for example `company.name` or `requirements.R3`);
- `gap`: states a missing or partial requirement; cites the requirement IDs it answers, and the fact ID filling `{related}` when a template is used;
- `courtesy`: greeting, thanks, sign-off; no references.

Kits:

- **Email kit:** subject, greeting, body sentences, closing. Code appends the profile's signature; Gmail does not add one to a `mailto:` draft's body.
- **Form kit:** cover-note sentences, and one answer per screening question, each marked `fixed` (filled by code) or `drafted`.
- **Message kit:** message sentences, at most 600 characters including the sign-off.

References live beside the text, never inside it, so copy-ready text is clean by construction.

## Stage `draft`

One Claude Opus 5.5 call through the platform wrapper, with structured output: the fit table and the kit.

- **Fit table:** one row per requirement of the chosen role: verdict `met`, `partial` or `gap`, the fact IDs behind it, and a short note.
- **Inputs:**
  - the approved profile (facts with depth and years, gap templates, known gap lines, style examples), placed first and marked for caching;
  - the chosen role's typed fields: title, company, requirements, screening questions;
  - the instructions the code accepted (below), as typed items.
  
  Raw post text is never sent to this stage.
- **Accepted instructions:** only those not addressed to AI, and only these kinds:
  - `subject_format`: applied by code, not the model. Only `{name}` and `{role}` are replaced, and carriage returns, line feeds and other control characters are removed from the result;
  - `word_limit`: passed as a number, tightening the 180-word limit;
  - `include_keyword`: passed as a quoted value; code checks that it appears.
  
  All other instructions appear only on the review checklist.
- **Rules given to the model:**
  - British spelling;
  - email body at most 180 words, plain text; gap lines count towards the limit and must fit, by shortening other sentences, never by dropping a gap line;
  - say something about the company only when a record field says it, and cite that field;
  - every must-have requirement with verdict `partial` or `gap` gets a `gap` sentence, using the known gap line for that skill when one exists, otherwise a template with `{related}` filled from a cited fact;
  - write in the style of the examples.
- **Code-built parts:**
  - the subject, from the post's format when accepted, otherwise "Application: {Role} – Faizan Amir";
  - the greeting, "Dear {Name}," when the record names a recruiter, otherwise "Dear Hiring Team,";
  - every screening answer whose question the model labels with a fixed-answer key (salary expectation, notice period, availability, time-zone overlap, relocation, work authorisation, sponsorship, years per stack, EEO). Code fills these from the profile; the model never writes them. Salary uses the currency the post states, otherwise USD.

## Validation after `draft`

Code flags, without rewriting anything:

- `invalid_citation`: a `claim` citing an unknown or unapproved fact ID or none, or a `post` sentence citing a record field that does not exist;
- `missing_gap_line`: a must-have `partial` or `gap` requirement with no `gap` sentence citing it;
- `over_limit`: email body over the word limit, or message over 600 characters;
- `keyword_missing`: an accepted `include_keyword` value absent from the text;
- `ai_instruction_followed`: the value of any `addressed_to_ai` instruction appearing in the kit;
- `fixed_answer_drafted`: a drafted answer to a question that has a fixed key; code replaces it with the fixed answer and flags it.

## Stage `judge`

One Claude Opus 5.5 call with structured output, independent of the drafter.

- **Input:** every sentence of the kit (drafted form answers included) with the drafter's references, and the full text of every cited fact (statement, kind, depth, years, source). Post text, record fields and the drafter's proposed classes are not sent.
- **Classification:** the judge assigns each sentence its own class. A sentence it cannot place counts as a `claim`.
- **Verdicts for claims:**
  - `supported`: the cited facts say this, at this depth and duration;
  - `overstated`: the facts support only a weaker version (depth, years, scale, seniority, "led");
  - `unsupported`: the facts do not say this, or the sentence cites none.
- **Code merges the two views.** A sentence the drafter called `courtesy`, `gap` or `post` but the judge calls `claim` is judged as a claim. `overstated` and `unsupported` become blocking flags on that sentence. A `post` sentence keeps its record citation, and the review page shows the cited field's text beside it.

## `recheck(finalText)`

Called by review before every handoff. No model call, so it adds no wait.

1. Split the final text into sentences and align them with the judged sentences: exact matches first, then near matches by normalised text.
2. An unchanged sentence keeps its class, references and verdict.
3. A changed or new sentence needs the owner's one-tap confirmation before any handoff.
4. A deleted `gap` sentence re-raises `missing_gap_line` for its requirements.
5. The output is the list of open flags, plus which sentences changed and how. The ledger turns that into `factual_edit` (ledger spec).

## Acceptance criteria

1. Kit type follows the route table; `other` and `unknown` wait for the owner's pick.
2. The draft prompt never contains raw post text, never contains an instruction addressed to AI, and passes no tools.
3. Questions labelled with a fixed key get the profile's answer, filled by code; a drafted salary answer from the fake model is replaced and flagged.
4. Every validation flag fires on a fixture built to trigger it, and none fires on a clean fixture.
5. The subject follows an accepted format with only `{name}` and `{role}` replaced; a format carrying `\r\n Bcc: x@evil.com` comes out with no line break; the default applies otherwise.
6. The signature comes from the profile; copy-ready text contains no IDs or markers.
7. The judge's input contains no post text, no record fields and no proposed classes. A claim the drafter labelled `courtesy` (for example "keen to bring my eight years leading AI teams") is classified as a claim and judged. A drafted "Yes" to "5+ years of React?" is judged against its cited facts.
8. `overstated` and `unsupported` verdicts produce blocking flags.
9. A must-have gap line is never dropped to meet the word limit; an over-long draft raises `over_limit` instead.
10. `recheck` alignment tests: an unchanged text keeps every verdict; a changed sentence needs confirmation; a deleted gap line raises `missing_gap_line`.
11. In the evaluation, `draft` plus `judge` take at most 30 seconds at the median.
