# Runbook: spikes (Task 8)

Three early checks, run once the first deploy is live and the phone is paired (setup steps 10 and 11). Each answers a question the plan depends on; the answers below decide what Task 27 builds and whether the share target stays on. Open `https://<your-vercel-domain>/spike` on the device named in each spike. Afterwards, the spike page and the `/api/spike/after` route are deleted. Task 13 replaced the service worker's spike report with the real share flow (2026-10-18), so the share target's check uses it.

## 1. Share target, on the phone

**Question:** does Chrome on the owner's Android phone deliver shared screenshots to an installed web app? A third-party report says Chrome 153 sends share requests with no parts at all.

1. In Chrome on the phone, open the site, then Chrome's menu, Install app. Note whether the install offer appeared.
2. In the gallery, select two screenshots of a job post, tap Share and choose jobkit.
3. jobkit opens New job and uploads the two screenshots with no tap, then opens the job. If it says "Nothing arrived from the share", Chrome delivered no screenshots.

| Item | Result |
|---|---|
| Date, phone model, Android version, Chrome version | |
| Install offered and installed | |
| The job opened with both screenshots | |
| Or: "Nothing arrived from the share" | |

**Decision:** if the job opened, the server's share-target switch stays on; if nothing arrived, `SHARE_TARGET_ON` in `src/server/shareTarget.ts` goes to false, and the New job page's upload button carries the flow (intake spec, "Share-target switch").

## 2. Gmail handoffs, on the phone

**Question:** which email handoff takes fewer taps from the button to a Gmail draft that is ready to send, with the CV attached (review spec, "Handoffs")? Nothing is sent: the address is `spike@example.com`; discard each draft at the end.

1. Tap Download the test CV once.
2. **A:** tap Open in Gmail, attach the test CV from Gmail's recent files, and count every tap from Open in Gmail until the draft is ready.
3. **B:** tap Share with CV, choose Gmail, paste the address and subject if Gmail has not filled them, and count every tap until the draft is ready.
4. Run each twice and note both counts.

| Mechanism | Taps, first run | Taps, second run | Notes (what Gmail filled in, what had to be pasted) |
|---|---|---|---|
| A: `mailto:` | | | |
| B: Web Share with the CV | | | |

**Decision:** the mechanism with fewer taps stays; on a tie, A, since it needs no file-sharing support.

## 3. A 200-second background run, on Vercel

**Question:** does work in `after()` run to 200 seconds on Vercel Hobby with Fluid compute, as the pipeline runner assumes (platform spec B9)?

1. On the laptop, tap Start a 200-second run.
2. In Vercel, the project's Logs, filter on `spike after()`. Within about four minutes, lines appear at 50, 100, 150 and 200 seconds, then "finished after 200 s".

| Item | Result |
|---|---|
| Date | |
| Last line logged | |

**Decision:** if the run finishes, the runner's plan stands. If it stops early, note when, and the runner's per-invocation budget (B9: start a model stage only if 215 seconds still fit before 285) is revised before Task 9.
