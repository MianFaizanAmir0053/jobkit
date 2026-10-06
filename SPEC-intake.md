# Spec: intake

- **Module id:** `intake` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `platform`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 1, 4 and 7, the input defaults, and amendments A7, A8 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A; job states from platform B9
- **Status:** draft for owner approval

## Objective

Get a job post from the owner's phone into storage as one job, as fast as the network allows, start the clock for both arms of the timing comparison, and recover when a phone upload breaks. Intake accepts screenshots and pasted text, never fetches a link, never shrinks text below legibility, and never lets image bytes pass through a Vercel function.

## Inputs

1. **Upload (always available).** The New job page offers "Choose screenshots" (`<input type="file" accept="image/*" multiple>`), a "Paste text" box and Start.
2. **Share target (extra).** The manifest declares a share target: `action` `/share-target`, method `POST`, `multipart/form-data`, with `title`, `text`, `url` and `files` named `images` accepting `image/*`. The service worker intercepts that POST, because routing it to a Vercel function would hit the 4.5 MB body limit. It then:
   - refuses a share with no images and no text, with "Nothing arrived from the share. Use Choose screenshots instead.";
   - refuses a share holding only a link, with "LinkedIn's share sends only a link, which jobkit never opens. Take screenshots of the post and share those.";
   - refuses every share while the server's share-target switch is off (below);
   - otherwise stores the files and text in IndexedDB under a share ID and redirects to `/jobs/new?share=<id>`, which loads them, starts the upload with no further tap, and deletes them from IndexedDB.
3. **Pasted text.** Up to 20,000 characters, from the box or from a share's `text` field. A URL in the text or in the share's `url` field is stored as a reference and never fetched.
4. **Adding screenshots to a job.** The job page offers "Add screenshots", with a purpose: `post` (more of the post) or `form` (an application form's screening questions). Adding `post` images moves the job to `extracting` for a fresh `extract`. Adding `form` images runs `extract_questions`, then drafting and judging for the new questions only.

**Share-target switch.** Turning the share target off in the manifest takes effect only when Chrome next updates the installed app, which can take days. So the switch lives on the server: the service worker reads it (cached for at most an hour) and refuses shares while it is off. The day-1 spike tests the share target on the owner's phone, because a third-party report says Chrome 153 on Android delivers share requests with no parts at all; if it fails, the switch goes off and the upload button carries the flow.

## Upload path

1. The client prepares each image:
   - decodes it at native resolution. Tall scrolling screenshots stay tall; extraction cuts them into tiles. Only an image wider than 2,576 pixels, which phones do not produce, is scaled down to that width;
   - refuses an image taller than 30,000 pixels with "Too tall. Take two shorter screenshots instead.";
   - encodes it as WebP at quality 0.9 when both sides are at most 16,383 pixels (WebP's limit), otherwise as JPEG at 0.92;
   - computes its SHA-256 and drops exact duplicates within the job;
   - computes how many tiles it needs, with the extraction spec's formula.
2. `POST /api/jobs` sends only metadata: count, sizes, dimensions, hashes, tile counts, the input kind, the pasted text, and `clientElapsedMs`, the monotonic time between the share's arrival (or the Start tap) and this request. The server checks every limit again, creates the job and assigns its timing arm (ledger spec). A manual-arm job starts in `manual_run`, uploads nothing, and the page shows the manual-run screen. Otherwise the job starts in `uploading` with its image rows, and the server returns one signed upload URL per image, each for a single path `jobs/<jobId>/<imageId>.<ext>` in the private bucket. Supabase fixes such URLs' validity at two hours.
3. The client uploads each file straight to Supabase Storage, with up to three attempts per file. If the page reloads or the network drops, `POST /api/jobs/<id>/upload-urls` issues fresh URLs for the files not yet stored, and the client resumes.
4. `POST /api/jobs/<id>/uploaded` asks the server to confirm that every object exists with the declared size. The job then moves to `queued` and the runner starts `extract`.
5. A job still `uploading` 15 minutes after creation moves to `upload_failed`; the page offers "Upload again". Objects that arrive after that are deleted by the purge.

Route handlers in this module reject request bodies over 64 KB, so image bytes cannot reach a function by mistake. Every upload attempt and its outcome is logged, so the Stats page can report upload success (the one-pager's 95% target).

## Limits

- At most 8 images per job, each at most 10 MB after encoding, and at most 20 tiles in total, the most one model request can carry without lower image limits. A job over the tile limit is refused with "Too many screenshots for one job. Remove some, or split the post into two jobs."
- Pasted text at most 20,000 characters.
- The New job page refuses to start when the ledger reports the monthly cap reached, and says so.

## Clock

The job stores `received_at` (server time of `POST /api/jobs`) and `client_elapsed_ms`. Its start time is `received_at` minus `client_elapsed_ms`: the moment the share arrived on the phone, or the moment the owner tapped Start. This is the start event for both arms of the timing comparison, because the arm is assigned to the job at creation (ledger spec).

## Storage and retention

- One private bucket, `jobkit-private`, with no public access. The server reads with the Supabase secret key; the browser sees images and crops only through signed URLs valid for 60 seconds.
- `job_images` rows hold the job ID, order, purpose, storage path, width, height, bytes, SHA-256, tile count, `created_at`, `purge_after` (30 days later) and `kept_for_eval`.
- The daily purge (platform B6) deletes, from storage and from the tables:
  - images and crops past `purge_after`, unless kept for evaluation;
  - objects under a job's path that arrived after the job left `uploading`;
  - pasted raw text older than 30 days.
- `npm run eval:pull` copies kept images to the laptop's evaluation folder and then clears `kept_for_eval`, so the 30-day rule deletes the cloud copy (amendment A7).

## Acceptance criteria

1. Uploading three screenshots creates one job with three images in order, stored under the job's path. No route handler receives image bytes; a body over 64 KB is refused.
2. Encoding: a 1,080 × 6,000 screenshot keeps its resolution; a 3,000-pixel-wide image is scaled to 2,576 pixels wide; a 1,080 × 20,000 image is encoded as JPEG; a 1,080 × 31,000 image is refused with the message above. Every image's SHA-256 and tile count are recorded; duplicates within a job are dropped.
3. Tile limit: two 1,080 × 30,000 screenshots (26 tiles) are refused by the client and again by the server.
4. Share target, end to end with a synthetic POST: images start an upload with no further tap; an empty share, a link-only share, and any share while the switch is off are refused with their messages and create no job.
5. A paste-only job works. A LinkedIn URL in the text is stored and never fetched; the test fails on any outgoing request to it.
6. A ninth image and text over 20,000 characters are refused with clear messages.
7. Upload recovery: after a simulated reload mid-upload, fresh URLs are issued for the missing files only, and the job completes. A job still `uploading` after 15 minutes moves to `upload_failed`; a late object is deleted by the purge.
8. Confirming a job whose objects are missing or the wrong size leaves it `uploading` with the missing files listed; creating or confirming a job needs an approved session.
9. With a fake clock, the purge deletes expired images and crops that are not kept, keeps kept ones, clears old pasted text, and `eval:pull` clears `kept_for_eval` after copying.
10. The job's start time equals `received_at` minus `client_elapsed_ms`.
11. Adding `post` screenshots moves a `kit_ready` job to `extracting`; adding `form` screenshots runs `extract_questions`, then drafting and judging for the new questions.
12. The Stats page's upload success rate counts every logged attempt.
