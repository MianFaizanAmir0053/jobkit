# Runbook: testing on the laptop

The thin path (the owner's choice, 2026-10-12) is built first so the owner can try a job end to end on the laptop: screenshots or pasted text in, an email draft out, handed to Gmail. The dev server keeps its database and files under `.data/`, so nothing needs Supabase or Vercel. Real model calls go to Gemini 3.8 Flash, and 3.6 Flash for the second read of an address (decisions A18), on the evaluation key: a few cents per test job on the paid tier, nothing on the free tier, where Google may use what jobkit sends, your profile's facts included, to improve its products.

## Once

1. **Google sign-in client:** [setup.md](setup.md), step 4. For the laptop, only `http://localhost:3000` (origin) and `http://localhost:3000/api/auth/google/callback` (redirect URI) are needed; add the Vercel ones when the app is deployed.
2. **Gemini:** setup.md, step 7: a key for `GEMINI_EVALS_API_KEY`. No Anthropic key is needed while every model stage runs on Gemini.
3. **`.env.local`:** the first bullet of setup.md, step 8: `OWNER_EMAIL`, `APP_ORIGIN=http://localhost:3000`, `JOBKIT_ENV=development`, `JOBKIT_LOCAL_EVALS=1`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GEMINI_EVALS_API_KEY`, which every model stage runs on, the second read of a screenshot's email address or number included; pasted text needs no second read, since jobkit looks for the address in the text. `OWNER_EMAIL` is also the Gmail account the job page opens and names as From, so make it the account you send applications from.
4. **Profile:** setup.md, step 13, items 1 and 2. Drafts use only the facts marked `approved: true`, so read the facts in `private/profile.yaml` and approve the ones you stand behind, and write the signature. The fixed answers decide the eligibility check, so make the work authorisation, relocation and working window entries true; gap lines and style examples can follow. With the dev server stopped, `npm run profile:seed` checks the file and stores it.

## Each time

1. `npm run dev`, then open http://localhost:3000 and sign in with Google.
2. **New job:** choose screenshots of a job post, or paste its text, and press Start.
3. The job page shows each step as it runs. A post with several roles asks which one; a post that is not a job post, not in English, or with no role found, stops. A role that looks closed to you (say, US only) waits for Draft anyway or Skip; one that is unclear goes on, its reasons shown with the email. If a reason comes from a wrong fixed answer, correct `private/profile.yaml`, run `npm run profile:seed` again with the dev server stopped, and send the post again as a new job: a job already checked keeps the answers it was checked with.
4. **One-click send** needs Gmail connected once: setup.md, step 4, item 4, then Devices, Connect Gmail.
5. A finished job shows the email: to, subject and body, with copy buttons and **Open in Gmail**, which opens Gmail's compose window with the draft filled in. Attach your CV there and send it yourself; then press **Mark sent**.

6. Before Open in Gmail and the copy buttons work, the page lists what holds them under "Before you send": type a disputed address yourself, as you read it in your screenshot or the pasted post, never from what jobkit read; press "I checked this" on each flagged sentence and flag, or "I will fix it in Gmail" where the email's words must change, and then change them in Gmail; tick any file besides the CV you will attach; press "Continue anyway" on a scam warning only once you have checked the post; and press "Apply again" if you mean to apply to a job you applied to before. Mark sent appears once nothing holds the email back. Once you mark it sent, or type the address again, the buttons hold on that page and in the same job's other tabs of the browser at once, and on the other device as soon as you bring its page back, or within 15 seconds on a page you keep in view; a page showing the old address never sends to it, and Mark sent from such a page is refused. Take back Mark sent undoes only the tap the page shows.

A post you try in jobkit cannot be a blind test case for the evaluation, since you saw jobkit's reading of it. The labelling page asks, for each sent email, whether you ever ran its post through jobkit: answer it honestly, and a post you did goes to `dev`.

## The phone, through a tunnel

The dev server runs on the laptop, and the phone reaches it through a free ngrok tunnel, which gives it an https address.

1. **Start the tunnel** from the hobby folder: `tools/ngrok/ngrok.exe http 3000 --config tools/ngrok/ngrok.yml` (Claude's launch setting `jobkit-tunnel` runs the same). Its address shows at http://localhost:4040.
2. **Point the app at it:** put the address in `.env.local` as `APP_ORIGIN`, with no trailing slash, and start `npm run dev` again. The laptop then uses that address too: while `APP_ORIGIN` is the tunnel's, requests from http://localhost:3000 are refused, and the dev server lets the tunnel's hostname load its pages (`allowedDevOrigins` in next.config.ts).
3. **Tell Google:** in Google Cloud Console, add the address to the OAuth client as an authorised JavaScript origin, and the address followed by `/api/auth/google/callback` as an authorised redirect URI. Google can take a few minutes to apply it.
4. **On the phone**, open the address in Chrome, press "Visit Site" on ngrok's warning (once per browser), and sign in with Google.

A free tunnel's address changes every time ngrok starts, and step 3 must follow it. A free static domain from the ngrok dashboard (Domains) keeps it fixed: start ngrok with `--url https://<your-domain>` and register it once. While the tunnel runs, the dev server can be reached from the internet: only the owner can sign in, but stop the tunnel when you are done and set `APP_ORIGIN` back to `http://localhost:3000`. The labelling page and its routes answer only on the laptop itself, never through the tunnel.
