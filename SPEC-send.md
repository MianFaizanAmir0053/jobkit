# Spec: send

- **Module id:** `send` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `review`, `ledger`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 10, 14, 19 and 20, deferred by amendment A1; one-click send brought into the MVP by amendment A20
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** Part 1, one-click send, is built (amendment A20, 2026-10-14). Part 2, the rest of milestone 2, is deferred: nothing there is built until the owner starts milestone 2, which needs a new approval and a refreshed spec.

## Part 1: one-click send (amendment A20)

The owner found the Gmail handoff too many steps and chose to approve and send in one click.

### Connecting Gmail

The Devices page connects Gmail once, through a consent flow of jobkit's own beside sign-in (PKCE and state as sign-in has them, returning through sign-in's callback). It asks for `gmail.send` with `openid email`, offline and with consent, keeps the connection only for `OWNER_EMAIL` and only when the permission to send was left ticked, and seals the refresh token with AES-256-GCM under `GMAIL_TOKEN_KEY` in the one-row `gmail_connection` table. The token never reaches a page. Google refusing the token, or a key that cannot open it, marks the connection refused: Devices then says so and offers Connect again, which it offers at any time, and Approve & send waits for it. Disconnect revokes the token at Google, then deletes the row, and says when Google did not confirm the revocation, so the owner can remove jobkit's access in the Google Account. Connecting again replaces the token without revoking the old one, since revoking can end the new grant with it.

### Approve & send

1. **Press.** On a ready email kit, "Approve & send" opens a confirmation in its place: From (the connected account), To, the subject, the CV's file name, and the flagged sentences and flags the press marks "I checked this". The button waits while Gmail is not connected or jobkit can no longer use it, while a decision from the same tab is in flight, while jobkit cannot find the CV, and while a reason it does not settle holds the kit: an address not confirmed, a blocking address check, a possible repeat, a scam warning, or a requirement only the owner can confirm, until they answer it. A post that asks for a file besides the CV is sent from Gmail, where the owner attaches it, ticked or not, and so is a kit whose words must change before it goes (decisions A22): a line the owner must write, a placeholder in the subject, a reference's details, a line written for an AI tool, or a must-have the owner said they do not meet, since Approve & send sends the words as they stand. On a paired phone the page says to connect Gmail from the laptop, since Devices is the laptop's.
2. **Send.** `POST /api/jobs/<id>/send` names the kit, the address, the earlier send that may have gone, and gives a key of the sentences and flags its confirmation listed and one of the email's words, as the page showed them. Under the kit's `kit_reviews` row lock it is refused when the page showed another kit or address, or did not show a send that may have gone, when the kit is sent, when the owner skipped the job, when a send of it is in flight, for a post that asks for a file besides the CV, for a kit whose words must change, or when such a reason holds it, or when the confirmation listed other sentences and flags than the press would mark, or the page showed other words than the email has, as after an edit on the other device; otherwise it marks "I checked this" on every sentence the judge holds and every flag from `validate` but those only new words resolve and those only the owner can answer, and keeps a `kit_sends` row scheduled ten seconds ahead, in one transaction. A partial unique index allows one send in flight (scheduled or sending) per job and role. While one is in flight, no decision on the kit is taken.
3. **Undo.** Until delivery claims it, `POST /api/jobs/<id>/send/undo` cancels it, and Undo of a send that failed is taken as done. The press counts as "I checked this" all the same, which the confirmation says.
4. **Delivery.** The press schedules it with Next's `after()`, which waits out the countdown, so it goes though the page is closed, while the server runs; the page also nudges it (`POST /api/jobs/<id>/send/deliver`) when its countdown ends, for a server that restarted. A try that throws, as on a dropped database connection, is tried again, twice. Delivery claims the send under the same locks, so it goes once; checks that the kit, its address and its gate stand as they did at the press; then builds the MIME message (the kit's subject in UTF-8 encoded words, the body with the profile's signature under the closing, since Gmail adds none to an email sent this way, and the CV of the profile version the email was written with, named after the owner) and uploads it to `users.messages.send` (`uploadType=media`, `message/rfc822`, 35 MB at most) with an access token refreshed from the sealed refresh token. Each step has its own limit (the CV 15 seconds, the token 15, the upload 30), and a delivery that has not reached Gmail a minute after its claim never does, so Gmail is done with every send well before the two minutes after which a send left sending counts as lost, and a press made then cannot meet it. The routes allow 120 seconds.
5. **Outcome.** Sent: what Gmail took, an answer of success with or without its IDs, is kept as sent with its message and thread IDs, whatever happened meanwhile, a skip included, in one transaction with the application marked sent with no change in Gmail, at the address the email went to, by the session that pressed it while that session lasts; that Mark sent cannot be taken back. The transaction is tried three times, since the IDs are only in memory; a ledger that cannot take it, or writes that keep failing, leave the send sent, with why, and a database that takes nothing leaves the IDs in the server log. Any sent send holds the kit as sent, whatever came after it. Refused by Google: not sent, connect Gmail again, with Google's words. The Gmail API not enabled in the Cloud project: not sent, enable it. Gmail's sending limit: not sent, try later. Any other refusal: not sent, press again. A connection that dropped once Gmail had the message, an error on Google's side, or a send a stopped server left sending for two minutes: `unknown`, since it may have gone, so the page says to check Gmail's Sent folder, then Mark sent or press again, and the confirmation says it again. The page keeps saying so, whatever later sends did, until the kit is sent; on a skipped kit it says to take the skip back and press Mark sent if the email went, and on a job whose Gemini draft beside the kit failed, to go back to the drafts and press Mark sent, its Skip warning that it closes the job for good. A send not delivered within two minutes of its time lapses, never sent late, and the page says so at once. `GET /api/jobs/<id>/send` gives the page the send as it now stands.
6. **The gate.** While a send counts down or sends, it holds every other outbound control and Mark sent, so the email never goes twice. Like those controls, Approve & send asks the server how its send stands when it is drawn, when the page is shown again, every 1.5 seconds while a send is in flight and every 15 otherwise, one question at a time; it shows the server's latest word, running the countdown from each answer, and the page is drawn again once for each word that differs from the page's. Undo stays while the server holds the send as scheduled, so a refused tap or a server that stopped never loses it, and the page says when it cannot reach jobkit. The page announces each step in a live region that outlives the control.

### Where Part 1 differs from the requirements below

- No trust gate, passkey or content-bound approval: the owner's press and the confirmation approve it (amendment A20). The press names the kit and the address, which delivery checks again, and gives a key of the sentences and flags its confirmation listed, so it marks only those.
- Ten seconds to undo, not fifteen (amendment A20).
- The server sends when the countdown ends though the page is closed, where the requirements below had the page commit, so a closed page sent nothing (Claude's choice, 2026-10-14, so a phone that sleeps still sends; the owner can change it).
- No daily cap and no deliverability test yet.
- A page left open on the other device learns of a send within one gate check, 15 seconds, longer than the countdown, so for those seconds its Open in Gmail stays open (a trade-off: the press and every delivery check the server, never the page).
- A claim whose commit is lost to a dropped connection, though the database kept it, leaves the send sending, which later reads as one that may have gone though it did not (a trade-off: a false warning, never a second email).

## Part 2: deferred (milestone 2)

### Why it waits

One-tap sending through the Gmail API was to unlock after ten email drafts in a row needed no factual edit. With email's share of applications unknown and send built last, that gate was unlikely to open within four weeks, while the send path carried the most new code and the most hazards. The MVP records the factual-edit rate and the trust-gate counter from day 1, so milestone 2 can start from evidence. This file keeps every requirement the reviews found, so none is lost.

### Requirements collected so far

#### Preconditions

- The trust gate is unlocked (ledger spec): 10 consecutive clean email outcomes; a later factual edit locks it, and 5 clean outcomes unlock it again.
- Gmail is connected through a consent flow of jobkit's own, separate from sign-in. It asks for `gmail.send` with offline access, and also `openid email`, so the callback can assert that the consenting account is `OWNER_EMAIL`. A token from any other account is discarded.
- A deliverability test has passed: once Gmail is connected, a test email with the CV goes to an address the owner names, and the owner confirms it landed in the inbox, not spam.
- The device has a passkey, registered with SimpleWebAuthn (`@simplewebauthn/server` and `@simplewebauthn/browser`), user verification required. Auth.js's passkey support is experimental and is not used.

#### Token handling

- The refresh token is encrypted at rest with AES-256-GCM (random 12-byte IV, key `TOKEN_ENCRYPTION_KEY` in Vercel), stored only in jobkit's own table, never in any library's account table.
- Revocation, a password change, six months without use or Google's per-client token limit all end the token. On `invalid_grant` the app marks it dead, shows a banner, and falls back to the Gmail handoff.

#### The send flow

1. **Prepare:** the server runs drafting's `validate` and the full outbound gate on the final kit, checks the daily cap (15 sends per Asia/Karachi calendar day) and the duplicate rules, and refuses when any required attachment other than the CV exists. Such posts always go through the Gmail handoff. It then computes a content hash over the canonical To, Subject, Body and attachment hashes, and creates a send intent whose idempotency key derives from the draft and that hash.
2. **Approve:** the WebAuthn challenge is the hash of the intent's content hash and a fresh nonce, so the fingerprint approves exactly this content. The assertion must match the challenge, the origin, the RP ID and user verification; a replay or an expired challenge fails.
3. **Undo window:** a 15-second countdown with Undo. The server sends only when the client explicitly commits after the countdown, so a closed or frozen page sends nothing; a background page never cancels or commits by itself.
4. **Commit:** the server records the intent as `attempted` before calling Gmail. It builds the MIME message: From the owner; To from the strict address check; Subject encoded per RFC 2047 after removing control characters; a UTF-8 plain-text body with the signature; the CV as a base64 PDF attachment. Then it calls `users.messages.send` once.
5. **After an ambiguous failure** (timeout or dropped connection after `attempted`), the server never retries by itself, because Gmail offers no idempotency key and `gmail.send` cannot read Sent to reconcile. The job shows "Check Gmail's Sent folder", with Mark sent and Send again, and Send again needs a fresh approval.
6. On success, the ledger records `sent`, the time, and the Gmail message and thread IDs, and the trust-gate outcome.

#### Acceptance criteria to carry over

1. Send is unavailable unless every precondition holds; each one is tested alone.
2. Prepare refuses on any outbound-gate reason, the daily cap, an unresolved duplicate, or an extra required attachment.
3. Approval is bound to the content hash; any change to To, Subject, Body or attachments needs a new intent and a new fingerprint.
4. Commit before the countdown ends, after Undo, with a different content hash, or a second time for the same intent never calls Gmail twice (a fake Gmail counts calls).
5. A page closed during the countdown sends nothing.
6. The MIME message has no header injected from post text, a correctly encoded non-ASCII subject, and the CV attached; total size under 25 MB.
7. A token from an account other than `OWNER_EMAIL` is rejected; `invalid_grant` leads to the banner and the handoff fallback.
