# Runbook: testing on the laptop

The thin path (the owner's choice, 2026-10-12) is built first so the owner can try a job end to end on the laptop: screenshots or pasted text in, an email draft out, handed to Gmail. The dev server keeps its database and files under `.data/`, so nothing needs Supabase or Vercel. Real model calls go to Claude Opus 5.5 with the evaluation key and cost about $0.10 to $0.20 per test job, inside that workspace's limit.

## Once

1. **Google sign-in client:** [setup.md](setup.md), step 4. For the laptop, only `http://localhost:3000` (origin) and `http://localhost:3000/api/auth/google/callback` (redirect URI) are needed; add the Vercel ones when the app is deployed.
2. **Anthropic:** setup.md, step 6, item 2 only: the `jobkit-evals` workspace with its $15 limit, and its key.
3. **`.env.local`:** the first bullet of setup.md, step 8: `OWNER_EMAIL`, `APP_ORIGIN=http://localhost:3000`, `JOBKIT_ENV=development`, `JOBKIT_LOCAL_EVALS=1`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ANTHROPIC_EVALS_API_KEY`. Add `GEMINI_EVALS_API_KEY` too if you have it: jobkit then reads a screenshot's email address or number a second time with Gemini Flash, at a fraction of a cent a job. Without it, a screenshot job asks you to type the address yourself; pasted text needs no key, since jobkit looks for the address in the text. `OWNER_EMAIL` is also the Gmail account the job page opens and names as From, so make it the account you send applications from.
4. **Profile:** setup.md, step 13, items 1 and 2. Drafts use only the facts marked `approved: true`, so read the facts in `private/profile.yaml` and approve the ones you stand behind, and write the signature. The fixed answers decide the eligibility check, so make the work authorisation, relocation and working window entries true; gap lines and style examples can follow. With the dev server stopped, `npm run profile:seed` checks the file and stores it.

## Each time

1. `npm run dev`, then open http://localhost:3000 and sign in with Google.
2. **New job:** choose screenshots of a job post, or paste its text, and press Start.
3. The job page shows each step as it runs. A post with several roles asks which one; a post that is not a job post, not in English, or with no role found, stops. A role that looks closed to you (say, US only) waits for Draft anyway or Skip; one that is unclear goes on, its reasons shown with the email. If a reason comes from a wrong fixed answer, correct `private/profile.yaml`, run `npm run profile:seed` again with the dev server stopped, and send the post again as a new job: a job already checked keeps the answers it was checked with.
4. A finished job shows the email: to, subject and body, with copy buttons and **Open in Gmail**, which opens Gmail's compose window with the draft filled in. Attach your CV there and send it yourself; then press **Mark sent**.

5. Before Open in Gmail and the copy buttons work, the page lists what holds them under "Before you send": type a disputed address yourself, as you read it in your screenshot or the pasted post, never from what jobkit read; press "I checked this" on each flagged sentence and flag, or "I will fix it in Gmail" where the email's words must change, and then change them in Gmail; tick any file besides the CV you will attach; press "Continue anyway" on a scam warning only once you have checked the post; and press "Apply again" if you mean to apply to a job you applied to before. Mark sent appears once nothing holds the email back. Once you mark it sent, nothing goes out from that page, or from the same job open in another tab or on the phone, until you take the tap back.

A post you try in jobkit cannot be a blind test case for the evaluation, since you saw jobkit's reading of it. The labelling page asks, for each sent email, whether you ever ran its post through jobkit: answer it honestly, and a post you did goes to `dev`.

## Not in the thin path yet

- the phone: test on the laptop first; the phone follows through a tunnel to the dev server. The labelling page and its routes answer only on the laptop itself, never through the tunnel.
