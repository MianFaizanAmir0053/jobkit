# Spec: intake

- **Module id:** `intake` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `platform`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 1, 4 and 7, the input defaults, and amendments A7, A8 and A11
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** draft for owner approval

## Objective

Get a job post from the owner's phone into storage as one job, as fast as the network allows, and start the clock. Intake accepts screenshots and pasted text, never fetches a link, never shrinks text below legibility, and never lets image bytes pass through a Vercel function.

## Inputs

1. **Upload (always available).** The New job page offers "Choose screenshots" (`<input type="file" accept="image/*" multiple>`), a "Paste text" box and Start.
2. **Share target (extra).** The manifest declares a share target: `action` `/share-target`, method `POST`, `multipart/form-data`, with `title`, `text`, `url` and `files` named `images` accepting `image/*`. The service worker intercepts that POST, because routing it to a Vercel function would hit the 4.5 MB body limit. It stores the files and text in IndexedDB under a share ID and redirects to `/jobs/new?share=<id>`. That page loads them and starts the upload with no further tap, then deletes them from IndexedDB.
3. **Pasted text.** Up to 20,000 characters, from the box or from a share's `text` field. A URL in the text or in the share's `url` field is stored as a reference and never fetched.
4. **Adding screenshots to a job.** The job page offers "Add screenshots", with a purpose: `post` (more of the post) or `form` (an application form's screening questions). Adding `post` images re-runs extraction; adding `form` images runs question extraction and answer drafting.

Day-1 spike: the share target is tested on the owner's phone. A third-party report says Chrome 153 on Android delivers share requests without their files. If it fails, the upload button carries the flow and the share target stays switched off.

## Upload path

1. The client prepares each image:
   - decodes it, keeping its native resolution. Tall scrolling screenshots stay tall; extraction cuts them into tiles (extraction spec). Only an image wider than 2,576 pixels, which phones do not produce, is scaled down to that width.
   - refuses an image taller than 30,000 pixels with "Too tall. Take two shorter screenshots instead.";
   - encodes it as WebP at quality 0.9 when both sides are at most 16,383 pixels (WebP's limit), otherwise as JPEG at 0.92;
   - computes its SHA-256 and drops exact duplicates within the job.
2. `POST /api/jobs` sends only metadata: count, sizes, dimensions, hashes, the input kind, the pasted text, and `clientElapsedMs`, the monotonic time between the share or Start tap and this request. The server creates the job (state `uploading`) and its image rows, and returns one signed upload URL per image, each scoped to a single path `jobs/<jobId>/<imageId>.<ext>` in the private bucket and valid for two minutes.
3. The client uploads each file straight to Supabase Storage.
4. `POST /api/jobs/<id>/uploaded` asks the server to confirm that every object exists with the declared size. The job then moves to `queued`, and the pipeline runner starts the first stage.

Route handlers in this module reject request bodies over 64 KB, so image bytes cannot reach a function by mistake.

## Limits

- At most 8 images per job, each at most 10 MB after encoding.
- Pasted text at most 20,000 characters.
- The New job page refuses to start when the ledger reports the monthly cap reached, and says so.

## Clock

The job stores `received_at` (server time of `POST /api/jobs`) and `client_elapsed_ms`. Its start time is `received_at` minus `client_elapsed_ms`, which counts the phone's compression and upload work without trusting the phone's wall clock. This is the tool arm's start event; the manual arm starts when the owner taps Start on the Baseline page with the post in hand (ledger spec).

## Storage and retention

- One private bucket, `jobkit-private`, with no public access. The server reads with the service-role key; the browser sees images only through signed URLs valid for 60 seconds.
- `job_images` rows hold the job ID, order, purpose, storage path, width, height, bytes, SHA-256, `created_at`, `purge_after` (30 days later) and `kept_for_eval`.
- The daily purge (platform B6) deletes images past `purge_after` and not kept for evaluation, from storage and from the table, and clears pasted raw text older than 30 days. Records and drafts follow the ledger's 180-day rule.

## Acceptance criteria

1. Uploading three screenshots creates one job with three images in order, stored under the job's path. No route handler receives image bytes; a body over 64 KB is refused.
2. A 1080 × 6000 scrolling screenshot keeps its resolution; a 3000-pixel-wide image is scaled to 2,576 pixels wide; a 1080 × 20,000 image is encoded as JPEG; a 1080 × 31,000 image is refused with the message above. Every image's SHA-256 is recorded, and duplicates within a job are dropped.
3. In an end-to-end test, a synthetic share POST is caught by the service worker, and the upload starts with no further tap.
4. A paste-only job works. A LinkedIn URL in the text is stored and never fetched; the test fails on any outgoing request to it.
5. A ninth image and text over 20,000 characters are refused with clear messages.
6. A signed upload URL works only for its path and only for two minutes; creating or confirming a job needs an approved session.
7. Confirming a job whose objects are missing or the wrong size fails, and the job is marked `failed` with the reason "upload incomplete".
8. With a fake clock, the purge deletes expired images that are not kept for evaluation, keeps those that are, and clears old pasted text.
9. The job's start time equals `received_at` minus `client_elapsed_ms`.
10. Adding `post` screenshots re-runs extraction; adding `form` screenshots runs question extraction only.
