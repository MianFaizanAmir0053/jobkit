"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { buttonVariants } from "@/components/ui/button";

import {
  browserPage,
  confirms,
  gateNudges,
  onOutboundHold,
  outboundHeld,
  readGate,
  watchGate,
} from "../polling";

import { CopyButton } from "./CopyButton";

/**
 * The kit's outbound controls (review spec, "The outbound gate"): Open in
 * Gmail, Open WhatsApp and the copy buttons. The page draws them open only when its gate
 * is, and they open only while the server agrees on what the page shows:
 * the kit, its gate, the address it goes to and the status of the role's
 * application, asked when they are drawn and again as polling.ts says. The
 * answer is forgotten the moment the page is hidden, while a decision from
 * this tab is in flight, and when a decision is made in another tab of this
 * browser, so a page drawn before the gate closed or the address was typed
 * again, brought back by Back or left open in a tab, waits for a new answer;
 * open on the other device, it learns within one check, 15 seconds at most.
 * One that no longer agrees is drawn again, a skip or a bounce, or the
 * taking back of either, included, though the gate stays closed throughout. Clicking never waits
 * for the server: the handoff happens inside the click.
 */
export function Outbound({
  jobId,
  kit,
  open,
  to,
  status,
  words,
  email,
  gmailHref,
  whatsApp,
  whatsAppHref,
  subject,
  body,
  noun,
}: {
  jobId: string;
  /** The kit the page shows. */
  kit: string;
  /** Whether the page's gate is open. */
  open: boolean;
  /** The address or number the page shows the kit going to; null for a route with none. */
  to: string | null;
  /** The status of the role's application the page shows; null before there is one. */
  status: string | null;
  /** The kit's words as the page shows them, as a short key. */
  words: string | null;
  /** Whether the kit is an email sent through Gmail: Gmail's control shows, held or not. */
  email: boolean;
  /** Gmail's compose link, for an email kit whose gate is open; null otherwise. */
  gmailHref: string | null;
  /** Whether the kit is a message for WhatsApp: WhatsApp's control shows, held or not. */
  whatsApp: boolean;
  /** WhatsApp's link to the number with the message, for a message whose gate is open; null otherwise. */
  whatsAppHref: string | null;
  /** The email's subject, to copy; null for a message, which has none. */
  subject: string | null;
  body: string;
  /** What the kit is called: "email" or "message". */
  noun: "email" | "message";
}) {
  const router = useRouter();
  const shown = `${kit}\n${String(open)}\n${to ?? ""}\n${status ?? ""}\n${words ?? ""}`;
  // What the server last agreed the page shows; nothing until it answers.
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const held = useSyncExternalStore(onOutboundHold, outboundHeld, () => false);

  useEffect(
    () =>
      watchGate(
        () => readGate(jobId),
        (answer) => {
          setUnreachable(answer === null);
          if (confirms(answer, { kit, open, to, status, words })) {
            setConfirmed(shown);
          } else {
            setConfirmed(null);
            if (answer !== null) router.refresh();
          }
        },
        browserPage(),
        {
          forget: () => setConfirmed(null),
          nudged: (listener) => {
            const stopOthers = gateNudges(jobId)(listener);
            const stopHolds = onOutboundHold(listener);
            return () => {
              stopOthers();
              stopHolds();
            };
          },
        },
      ),
    [jobId, kit, open, to, status, words, shown, router],
  );

  const enabled = open && confirmed === shown && !held;
  // A handoff jobkit could not record: Mark sent would record other words than went.
  const [unrecorded, setUnrecorded] = useState(false);
  // Each handoff posts the words and the parts it handed off, right after the click, which Mark
  // sent records; the handoff never waits for it (review spec, "The outbound gate"). An email's
  // alone: factual edits count for email handoffs only (ledger spec).
  const handedOff = (parts: ("subject" | "body")[]) => () => {
    if (words === null || !email) return;
    void fetch(`/api/jobs/${jobId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kit, words, parts }),
      keepalive: true,
    })
      .then((response) => setUnrecorded(!response.ok))
      .catch(() => setUnrecorded(true));
  };
  const waiting = !open
    ? ""
    : held
      ? "Your change is not saved yet: the buttons wait for it."
      : confirmed === shown
        ? ""
        : unreachable
          ? `jobkit cannot be reached to confirm that nothing holds this ${noun} back, so the buttons wait. It asks again every 15 seconds.`
          : `Checking that nothing holds this ${noun} back…`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {email &&
          (enabled && gmailHref !== null ? (
            <a
              href={gmailHref}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonVariants()} min-h-11`}
              onClick={handedOff(["subject", "body"])}
            >
              Open in Gmail
            </a>
          ) : (
            <span
              role="link"
              aria-disabled="true"
              className={`${buttonVariants()} pointer-events-none min-h-11 opacity-50`}
            >
              Open in Gmail
            </span>
          ))}
        {whatsApp &&
          (enabled && whatsAppHref !== null ? (
            <a
              href={whatsAppHref}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonVariants()} min-h-11`}
              onClick={handedOff(["body"])}
            >
              Open WhatsApp
            </a>
          ) : (
            <span
              role="link"
              aria-disabled="true"
              className={`${buttonVariants()} pointer-events-none min-h-11 opacity-50`}
            >
              Open WhatsApp
            </span>
          ))}
        {subject !== null && (
          <CopyButton
            text={subject}
            label="Copy subject"
            disabled={!enabled}
            onCopied={handedOff(["subject"])}
          />
        )}
        <CopyButton
          text={body}
          label={noun === "email" ? "Copy email" : "Copy message"}
          disabled={!enabled}
          onCopied={handedOff(["body"])}
        />
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {waiting}
      </p>
      {unrecorded && (
        <p role="alert" className="text-sm font-medium">
          jobkit could not record what you just handed off, as the email changed meanwhile or the
          connection dropped. If you send it, answer Yes when jobkit asks whether you changed
          anything, unless it reads as jobkit drafted it.
        </p>
      )}
    </div>
  );
}
