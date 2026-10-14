# Spec: send

- **Module id:** `send` (see [CAPABILITIES.md](CAPABILITIES.md))
- **Depends on:** `review`, `ledger`
- **Decisions:** [ADR 0001](docs/decisions/0001-mvp-decisions.md) entries 10, 14, 19 and 20, deferred by amendment A1; one-click send brought into the MVP by amendment A20
- **Conventions:** [SPEC-platform.md](SPEC-platform.md) Part A
- **Status:** Part 1, one-click send, is built (amendment A20, 2026-10-14). Part 2, the rest of milestone 2, is deferred: nothing there is built until the owner starts milestone 2, which needs a new approval and a refreshed spec.

## Part 1: one-click send (amendment A20)

The owner found the Gmail handoff too many steps and chose to approve and send in one click.

### Connecting Gmail

The Devices page connects Gmail once, through a consent flow of jobkit's own beside sign-in (PKCE and state as sign-in has them, returning through sign-in's callback). It asks for `gmail.send` with `openid email`, offline and with consent, keeps the connection only for `OWNER_EMAIL` and only when the permission to send was left ticked, and seals the refresh token with AES-256-GCM under `GMAIL_TOKEN_KEY` in the one-row `gmail_connection` table. The token never reaches a page. Disconnect revokes it and deletes the row.

### Approve & send

1. **Press.** On a ready email kit, "Approve & send" opens a confirmation in its place: From (the connected account), To, the subject, the CV's file name, and the flagged sentences and flags the press marks "I checked this". The button waits while Gmail is not connected, and while a reason it does not settle holds the kit: an address not confirmed, a blocking address check, a possible repeat, a scam warning, or a required attachment besides the CV.
2. **Send.** `POST /api/jobs/<id>/send` names the kit and the address the page showed. Under the kit's `kit_reviews` row lock it is refused when the page showed another kit or address, when the kit is sent, when a send of it is live, or when such a reason holds it; otherwise it marks "I checked this" on every sentence the judge holds and every flag from `validate`, and keeps a `kit_sends` row scheduled ten seconds ahead, in one transaction. A partial unique index allows one live send (scheduled, sending or sent) per job and role.
3. **Undo.** Until delivery claims it, `POST /api/jobs/<id>/send/undo` cancels it. The press counts as "I checked this" all the same.
4. **Delivery.** The press schedules it with Next's `after()`, which waits out the countdown, so it goes though the page is closed; the page also nudges it (`POST /api/jobs/<id>/send/deliver`) when its countdown ends, for a server that restarted. Delivery claims the send under the same locks, so it goes once; checks that the kit, its address and its gate stand as they did at the press; then builds the MIME message (the kit's subject in UTF-8 encoded words, the body with the profile's signature under the closing, since Gmail adds none to an email sent this way, and the CV of the profile version the email was written with, named after the owner) and uploads it to `users.messages.send` (`uploadType=media`, `message/rfc822`, 35 MB at most) with an access token refreshed from the sealed refresh token.
5. **Outcome.** Sent: the row keeps Gmail's message and thread IDs, the application is marked sent with no change in Gmail, and that Mark sent cannot be taken back. Refused by Google: not sent, connect Gmail again. An error from Gmail: not sent, press again. A connection that dropped once Gmail had the message: jobkit cannot tell, so the page says to check Gmail's Sent folder, then Mark sent or press again. A send not delivered within two minutes of its time lapses, never sent late; one a stopped server left sending for two minutes is failed at the next press, with word to check the Sent folder. `GET /api/jobs/<id>/send` gives the page the send as it stands.
6. **The gate.** While a send counts down or sends, it holds every other outbound control and Mark sent, so the email never goes twice.

### Where Part 1 differs from the requirements below

- No trust gate, passkey or content-bound approval: the owner's press and the confirmation approve it (amendment A20). The press names the kit and the address, which delivery checks again.
- Ten seconds to undo, not fifteen (amendment A20).
- The server sends when the countdown ends though the page is closed, where the requirements below had the page commit, so a closed page sent nothing (Claude's choice, 2026-10-14, so a phone that sleeps still sends; the owner can change it).
- No daily cap and no deliverability test yet.

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
