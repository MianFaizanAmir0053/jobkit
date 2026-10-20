# Spec: extraction

- **Module id:** `extraction` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `intake`, `profile`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 2, 15, 16 and 18, the multi-role and language defaults, and amendments A4 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A; job states, stage hashes and the model wrapper from platform B4 and B9
- **References:** [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding), [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision), [vision coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output), [WhatsApp click to chat](https://faq.whatsapp.com/5913398998672934)
- **Status:** approved by the owner on 2026-10-06, after two review cycles

## Objective

Turn a job's screenshots or pasted text into a validated job record, treating every word of the post as untrusted data. Find each role's application route and contact, read the contact a second time with a different model, and decide before any drafting whether the owner is likely eligible. Stages registered with the platform's runner: `extract`, `extract_questions`, `address_read` and `eligibility`; the `needs_role_pick` waiting state belongs here too.

## Images sent to the model

The geometry below was made for Claude, and stays now that every model stage runs on Gemini (decisions A18): Gemini reads the same tiles, and the cost estimate's count of their tokens errs high for it. Claude's high-resolution models accept at most 2,576 pixels on the long edge and 4,784 visual tokens per image, where an image costs ⌈width/28⌉ × ⌈height/28⌉ tokens. Larger images are silently downscaled, and coordinates then refer to the downscaled image. So code cuts images to fit, and never lets the API resize them:

- **Tile height** for an image of width `w` is `min(2576, 28 × floor(4784 / ceil(w / 28)))`. For a 1,080-pixel-wide phone screenshot that is 2,576; for a 2,576-pixel-wide image, 1,456.
- An image whose height is within its tile height is sent whole. A taller one is cut into horizontal tiles of that height, overlapping by 200 pixels, at full width.
- Every image block carries `transformations: { oversized_image: "error" }`, so a sizing mistake fails loudly instead of shifting coordinates (the exact field is checked against the vision-coordinates page at implementation).
- Tiles are cut on the server with `sharp`, in memory, from the stored image, and encoded losslessly (PNG), so text never goes through a second lossy pass. Before sending, code checks that the request stays under 30 MB; a job over that is refused with "Too much image data for one job".
- One request carries at most 20 image blocks, because more than 20 lowers the per-image limit. Intake refuses jobs whose images would need more.
- Each tile carries its image index and vertical offset. A box the model returns for a tile is mapped back to the original image by adding the offset.

## Job record

The record schema is a zod schema, also sent as the structured-output format.

- **Within the limits:** structured outputs allow at most 24 optional and 16 union-typed parameters per request (a nullable field counts as a union) and `minItems` of 0 or 1 only. The schema therefore uses sentinel values instead of nulls: empty strings, `-1` for an unknown number, `"unspecified"` enum members and empty arrays.
- **No bounds the API ignores:** the schema holds no regular expressions or length limits, because the SDK's zod helper would enforce them after parsing and fail the stage. Those checks run afterwards as flags (below).
- **Tests:** a unit test counts optional and union-typed parameters in every structured schema of this module and of drafting, and fails above 20 and 12. A live smoke test (`--mode live`, by hand) sends each schema once, to catch "schema too complex" errors the counts cannot predict.
- **Quotes** are trimmed by the prompt to at most 120 characters each, to keep output short.

Fields:

- `post_kind`: `job_post` or `not_a_job_post`; `language`: `en` or `other`.
- `company`: name and website as shown, or empty. `recruiter`: name and title as shown, or empty.
- `scam_signals` (for the whole post): kind (`national_id`, `bank_details`, `fee`, `personal_messaging_only`, `other`) with the quote.
- `roles`: one entry per role the post offers. Each role has:
  - an ID (`P1`, `P2`, …, in the order the post lists the roles), which the ledger keys each application on, so two roles written alike stay apart;
  - `title`, `seniority` (intern to principal, or `unspecified`) and `employment` (full-time, part-time, contract, internship, `unspecified`);
  - `location`: work mode (remote, hybrid, onsite, `unspecified`); places, each with the text as written and its place code from the shared region table (below) or `"unknown"`; remote regions as written; and the time-zone requirement as a zone (IANA name or `"unspecified"`), a minimum overlap in hours (or `-1`) and the text as written;
  - `eligibility`: work-authorisation requirements, each with a place code and the quote; sponsorship (`offered`, `not_offered`, `unspecified`); other limits (citizenship, security clearance and the like) as quotes;
  - `salary`: the text as written, currency, minimum, maximum (`-1` when absent) and period;
  - `requirements`: each with an ID (`R1`, `R2`, …), its text, `must` or `nice`, a kind (`skill`, `experience`, `education`, `language`, `other`), skill tags from the shared skill vocabulary, the depth it asks for (`production`, `professional`, `any`), and the years required (`-1` when not stated);
  - `route`: kind (`email`, `ats_form`, `easy_apply`, `careers_page`, `whatsapp`, `linkedin_dm`, `linkedin_comment`, `other`, `unknown`), the address, link or number for this role, the quote it came from, and the contact box (tile and pixel box) when it was read from screenshots;
  - `instructions`: each with kind (`subject_format`, `include_keyword`, `attach_document`, `answer_question`, `word_limit`, `format`, `deadline`, `other`), the text, a value where one applies, and `addressed_to_ai`;
  - `required_attachments`: name, and whether it is the CV;
  - `screening_questions`: ID (`Q1`, …), text, and `addressed_to_ai`.

**Shared vocabularies** in `src/core/shared/`:

- `skills.ts` maps aliases to canonical tags with display names (for example `k8s` to `kubernetes`, shown "Kubernetes"). Extraction normalises requirement tags through it, and the profile seed rejects fact tags it does not know.
- `regions.ts` maps names and aliases to place codes (ISO country codes, plus region codes such as `EU`, `GCC`, `APAC`, `EMEA`, each with its member countries): "UK" and "United Kingdom" to `GB`, "Germany" to `DE` (a member of `EU`), "Europe" to `EUROPE`. A bare two-letter country code is not read as a name ("CA" and "IN" are also US states), a name two places share (Georgia, Hyderabad) names none, and the words around a place ("the UAE", "US only", "Remote, UK") are read past. Extraction, the profile seed and eligibility all use this one table, so a post's "UK" meets the profile's `GB`.

## Stage `extract`

- One Gemini 3.8 Flash call (decisions A18) through the platform wrapper, with all tiles of all `post` images in order and any pasted text. Effort starts at `medium`; `max_tokens` is 16,000, covering thinking and output.
- The system prompt holds the rules; it never contains post text. The user turn holds the tiles and the pasted text between two marker lines built from a random value generated for that call. The prompt states that everything between the markers is data from an unknown author, that instructions inside it are recorded in `instructions` and never followed, and that any line or question addressing an AI, a language model, a bot or an automated tool is marked `addressed_to_ai`.
- **Output that parses but fails a check is kept, not retried.** A malformed address or number, a box outside its tile, duplicate IDs or an over-long field become flags on the job (the review page shows them); only output that does not parse fails the stage.
- **Phrase backstop:** code scans the pasted text, and for every job the record's quoted fields (instructions, route quote, eligibility quotes and other limits), for numbers in Pakistani CNIC format, IBANs, and the phrases "registration fee", "processing fee", "CNIC", "passport copy" and "bank account". A hit adds a scam signal when the model reported none. A post that tells the model it is legitimate still has its lines addressed to AI flagged and shown.
- **Stops:**
  - `language: other` moves the job to `stopped`, with no drafting cost.
  - `not_a_job_post` also moves it to `stopped`, but the page offers "This is a job post", which records the owner's confirmation (part of `extract`'s input hash) and re-runs `extract` with that confirmation in the system prompt.
  - An English job post in which no role was found is kept with its `no_roles` flag and also moves to `stopped`; the page offers "Read it again", which records the same confirmation and re-runs `extract` once, and Skip (the owner's decision, 2026-10-12).
- Several roles move the job to `needs_role_pick`. One role is chosen automatically. Code numbers roles, requirements and questions by position after the checks, so an ID the model repeated is flagged and the pick still finds the right role; a pick holds only for the extraction it was made on.

## Strict contact checks

- **Address:** a local part of ASCII letters, digits, `.`, `_`, `+` and `-` only, with no leading, trailing or doubled dot; one `@`; a domain of labels made of ASCII letters, digits and hyphens, ending in a public suffix (`tldts`). Anything else fails, including `%`, `#`, `&`, `?`, `=`, `/`, commas, spaces, quotes and a second `@`. A post therefore cannot smuggle a recipient or a header into the handoff link, even through percent-encoding.
- **WhatsApp number:** after removing spaces, dashes, dots and brackets, and after dropping a trunk `0` written as `(0)` after a country code, only these forms are accepted:
  - `+` or `00`, then a country code and number;
  - `92` then 10 digits (Pakistan with its country code);
  - `03` then 9 digits (a Pakistani mobile, which becomes `923…`).
  
  The full number must have the length its country code allows: 12 digits for `92`, `44`, `971` and `966`, 11 for `1`, and 8 to 15 for codes the table does not list. Any other form is flagged "Check this number's country code", and the owner types it; jobkit never guesses a country.

## Stage `needs_role_pick`

The job page lists the roles with title, location and route. The owner picks one, and the chain continues with that role. Picking another role later creates a separate application for it under the same job (ledger spec).

## Stage `extract_questions`

Runs when the owner adds `form` screenshots to a job, for example the screening questions LinkedIn Easy Apply or an ATS form shows. One call on `extract`'s model sees only those images, tiled, under the same marker and untrusted-data rules, and returns the questions with `addressed_to_ai`. They are appended to the chosen role's `screening_questions` with IDs that continue the sequence; drafting's `draft_answers` then answers the new questions only. A question addressed to AI is flagged and never answered. The fields for a name, contact details, profile links and files are left out. Its output keeps every question added so far and the screenshots it read, so a later batch reads only its own, and the chosen role reads the added questions from it; a fresh `extract`, as after more of the post is added, numbers the post's questions afresh and drops the added ones, which the owner adds again (Claude's choices, 2026-10-20).

## Stage `address_read`

Runs for email and WhatsApp routes whose record gives a contact, alongside `draft` (platform B9). Its input hash stands for the crop by the screenshot's hash, the box and the crop's rules, from which code makes the crop, so nothing is read from storage before it runs. Whether the machine has the Gemini model is part of the input too, so when the drafting group runs again with a key now set, as after Retry, the read happens. A read that cannot happen, a box that does not fit its screenshot, a screenshot storage cannot give after a second try (each storage call has ten seconds), a crop that cannot be made, a model call that fails or throws, or an answer that is not text a database can keep, leaves the second read missing, and no Gemini key on the machine is recorded as such: either is a blocking flag, never a failed job. A crop that cannot be stored in time is still read. The output names the contact it was for, and a read made for another contact counts as no second read of the one that stands.

- **From screenshots:** code crops the chosen role's contact box on the original image with a 40-pixel margin, at least 240 by 64 pixels, clamped to the image, and enlarges it twofold with `sharp`. A Gemini Flash call (amendment A4) sees only the crop, as untrusted data between markers, and returns the email address or phone number it shows, or none. The crop is stored at `jobs/<jobId>/crops/` and purged with the job's images (intake spec).
- **From pasted text:** no model call. An address must appear verbatim in the text, whole: next to nothing that could continue it. Before it, that is a letter, digit or mark of any script, a full stop, "@", an apostrophe, straight or curly, or another symbol an address may hold (RFC 5322's atext, so a brace too); after it, a letter, digit or mark, a hyphen, an underscore, "@", or a full stop with more of a domain after it. Anything else, a space, punctuation, a quote, an emoji or an invisible character, is an edge, and a pair of WhatsApp's bold or italic marks ("*hr@acme.com*") is read through to the marks' own edges. A number must appear in the text with the same digits after normalisation: a run of digits is read whole, or without a bracketed note after it ("0300-1234567 (9am-5pm)"), never cut inside its digits and never across a line. The matching's version is part of the input.
- **Agreement:** addresses agree when equal after trimming and lower-casing; numbers when equal after normalisation. Disagreement, a missing second read, an invalid box, a missing crop, no second model, or a number whose country code cannot be read sets a blocking flag. The review page then shows the full screenshot, zoomable, and asks the owner to retype the address or number; choosing one of the two reads does not clear it.

## Stage `eligibility`

Deterministic code, no model, run before any drafting. It compares the chosen role with the profile's structured fixed answers (profile spec), through the shared region table, and returns `eligible`, `unclear` or `likely_ineligible`, each with its reasons. The overall result is the most severe one found (`likely_ineligible`, then `unclear`, then `eligible`).

- **Where the work is done:** a role's remote regions and, when it is onsite or hybrid, its places are alternatives. The role passes when any one of them passes ("onsite in Lahore, or remote in the US only" passes through Lahore); when none does, it takes the least severe of their findings. What the post leaves open beside them, an onsite or hybrid role with no place, is reported apart, so it never cancels a clear exclusion. The places of a role whose work mode the post does not give, or of a remote role that names places but no region ("London · Remote"), may be where it is done: one that passes is a passing alternative, and the others are reported, never past `unclear`, only when no alternative passes. An onsite or hybrid role whose only place is "anywhere" leaves open where it is; for a role of no clear work mode, "anywhere" passes, and a place that might be where the work is (one the owner would relocate to) is an alternative like an onsite place.
- **Remote regions:** each phrase is looked up whole (never as a substring) in the region table. A region that includes Pakistan passes. A region that excludes it, such as "US only", gives `likely_ineligible` with the quote. A phrase the table does not know, or a region whose membership is ambiguous ("EMEA", "MENA"), gives `unclear`. A region that excludes Pakistan but that the owner's relocation answer covers gives `unclear` instead, as an onsite role there would (the owner's rule, 2026-10-12).
- **Work authorisation:** each required place is matched to the profile's entry for that place, or for a region containing it (Germany meets an `EU` entry). Not authorised and sponsorship `not_offered` gives `likely_ineligible`; not authorised and sponsorship `unspecified` or `offered` gives `unclear`; a place the profile does not cover gives `unclear`. When the owner may work in one of the places a post lists, the others give `unclear` at most, since the list cannot say "or" from "and" (the owner's rule, 2026-10-12). The owner's own country counts as a place they may work in when the profile has no entry for it. "No sponsorship" gives `likely_ineligible` only where the profile does not say the owner would need none; where it does, `unclear`. An entry with no words and no place, or for "anywhere", asks nothing.
- **Onsite or hybrid places:** the role passes if any one of its places passes ("London or Lahore" passes through Lahore). A place is read from the post's words through the region table first, and from the model's code only when the table does not know the words. A place in Pakistan passes; a region that takes in Pakistan ("South Asia") gives `unclear`. Elsewhere: relocation `open` with the place, a region containing it, or a place sharing a country with it, in the profile's list gives `unclear`; relocation `open` with an empty list gives `unclear`; relocation closed, or open only to other places, gives `likely_ineligible`; an unknown place gives `unclear`. An onsite or hybrid role whose post names no place, or names only "anywhere", gives `unclear`; a place the post gives only as a code still counts.
- **Other limits** (citizenship, security clearance, a degree from a named country, and anything the record lists there) give `unclear`, with the quote.
- **Time zone:** when the role names a zone, code computes the overlap between the owner's working window and 09:00 to 17:00 in that zone, on a 24-hour circle, so windows that cross midnight in UTC count correctly. Less than the stated minimum overlap, or under 2 hours when none is stated, gives `unclear` with the hours shown. A zone given as unspecified, in any case, is not checked, unless the post still asks for a minimum overlap or says something about working hours, which gives `unclear`; a zone the runtime cannot read gives `unclear`. The zone is named as the runtime knows it ("America/Los_Angeles"), the overlap is rounded down so a shortfall never reads as enough, and the post's number of hours shows only when it is one a post could mean. Only the post's own words are quoted, never a zone the model inferred.
- Blank entries the model returns (an empty region, limit or permit) are skipped.

Draft anyway answers one role on one reading of the post: it is recorded with the role and the extract output it was made on, and a later extraction or another role asks again.

`likely_ineligible` moves the job to `needs_eligibility_decision` (Draft anyway or Skip). `unclear` continues, with the reasons shown as a banner.

## Latency and cost budget

The ADR's target is a median machine time of 60 seconds from share to kit. With Claude Opus 5.5 at every model stage (thinking always on), the reviews estimated about 90 seconds of model time and about $0.27 per typical job; every stage now runs on Gemini Flash (decisions A18), which the evaluation times afresh. The budget per stage is: `extract` 25 seconds, the drafting group 30, `judge` 15. Checkpoint C of the plan measures each stage on the evaluation set, and checkpoint D measures machine time end to end in production. If the median exceeds 60 seconds, the owner decides, on that evidence, between lower effort, another model for some stages, or a revised target (amendment A9). Nothing changes model or target without that decision.

## Acceptance criteria

Criteria about what the model notices (lines addressed to AI, scam signals in images, roles, depth asked for) are evaluation criteria in the evals spec, scored on synthetic cases. The tests below use the fake model.

1. Tiling: a 1,080 × 2,400 image goes whole; a 1,080 × 6,000 image becomes three tiles of at most 2,576 pixels with 200-pixel overlaps; a 2,576-pixel-wide image uses 1,456-pixel tiles; every tile stays within 4,784 visual tokens; every block carries the oversized-image error setting; tiles are PNG; a request over 30 MB is refused; a box in a later tile maps back with the right offset.
2. Schemas: the counting test passes for every structured schema in extraction and drafting; no schema contains a regular expression or length bound; `minItems` is never above 1.
3. The record schema accepts every synthetic fixture and rejects malformed ones; output that parses but fails a check is kept and flagged, not retried.
4. The system prompt never contains post text; the post sits between per-call random markers; the wrapper call passes no tools (type-level test).
5. The phrase backstop adds a scam signal when a CNIC request appears in pasted text, and when it appears only in a quoted field of a screenshot's record, while the fake model reports none.
6. A non-English post stops the job, and its only exit is Skip; a `not_a_job_post` verdict stops it, and "This is a job post" re-runs `extract` with a new input hash rather than reusing the stopped result; a post with no role found stops it with the record kept, and "Read it again" re-runs `extract` once.
7. A post with several roles waits in `needs_role_pick`; scam signals stay attached to the post whichever role is picked; each role keeps its own contact.
8. Strict checks: `hr@acme.com?bcc=x@evil.com`, `spy%40evil.com%2Chr@acme.com`, `a#b@acme.com`, `"hr"@acme.com`, `hr..x@acme.com`, `hr@acme` and `hr@@acme.com` fail; `jobs+dev@acme.co.uk` passes. `0300 1234567` becomes `923001234567`; `+92 (0)300 1234567` becomes `923001234567`; `+971 50 123 4567` becomes `971501234567`; `202 555 0143`, `300-1234567` and `+92 300 12345` are flagged.
9. Crops include the margin, respect the minimum size, are clamped to the image, are enlarged twofold, and are stored under the job's `crops/` path.
10. Agreement: equal reads pass; different reads, a missing second read, an invalid box or a missing crop set the blocking flag; pasted text passes only when the address appears verbatim or the number's digits appear.
11. Eligibility table tests:
    - "US only" gives `likely_ineligible`; "worldwide" gives `eligible`; "EMEA" and "Southeast Asia" give `unclear`;
    - a right-to-work requirement for Germany with no sponsorship meets the profile's `EU` entry and gives `likely_ineligible`; the same with sponsorship unspecified gives `unclear`; a place the profile does not cover gives `unclear`;
    - "London or Lahore" passes; onsite in Dubai with relocation open to `AE` gives `unclear`; onsite in Berlin with relocation open only to `AE` gives `likely_ineligible`; "onsite in Lahore, or remote in the US only" passes;
    - a citizenship limit gives `unclear`;
    - a role in `Australia/Sydney` against a working window of 04:00 to 13:00 UTC computes the overlap across midnight correctly;
    - several findings combine to the most severe.
12. Each model call is logged under its stage name (`extract`, `extract_questions`, `address_read`).
