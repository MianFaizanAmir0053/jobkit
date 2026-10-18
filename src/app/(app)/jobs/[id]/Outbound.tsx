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
import { inFlight } from "./handoffs";

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
  application = false,
  applicationHref = null,
  fields = [],
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
  /** What the kit is called: "email", "message" or "form". */
  noun: "email" | "message" | "form";
  /** Whether the kit is a form with an https link to apply through: its control shows, held or not. */
  application?: boolean;
  /** The post's https link to apply through, for a form whose gate is open; null otherwise. */
  applicationHref?: string | null;
  /** A form's fields, each copied on its own: the cover note, then each answer. */
  fields?: { name: string; text: string }[];
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
  // The parts whose last handoff jobkit could not record: Mark sent would record other words than
  // went, until that part is handed off again.
  const [unrecorded, setUnrecorded] = useState<ReadonlySet<string>>(new Set());
  // Each handoff posts the words, the address the page showed and the parts it handed off, right
  // after the click, which Mark sent records; the handoff never waits for it (review spec, "The
  // outbound gate"). An email's alone: factual edits count for email handoffs only (ledger spec).
  const handedOff = (parts: ("address" | "subject" | "body")[]) => () => {
    if (words === null || !email) return;
    const recorded = (ok: boolean) =>
      setUnrecorded((was) => {
        const now = new Set(was);
        for (const part of parts) {
          if (ok) now.delete(part);
          else now.add(part);
        }
        return now;
      });
    const posted = fetch(`/api/jobs/${jobId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kit, words, to: to ?? "", parts }),
      keepalive: true,
    })
      .then((response) => recorded(response.ok))
      .catch(() => recorded(false));
    inFlight(posted);
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
              onClick={handedOff(["address", "subject", "body"])}
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
        {application &&
          (enabled && applicationHref !== null ? (
            <a
              href={applicationHref}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonVariants()} min-h-11`}
            >
              Open application link
            </a>
          ) : (
            <span
              role="link"
              aria-disabled="true"
              className={`${buttonVariants()} pointer-events-none min-h-11 opacity-50`}
            >
              Open application link
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
          label={noun === "email" ? "Copy email" : noun === "message" ? "Copy message" : "Copy all"}
          disabled={!enabled}
          onCopied={handedOff(["body"])}
        />
      </div>
      {fields.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {fields.map((field, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{field.name}</span>
              <CopyButton
                text={field.text}
                label="Copy"
                ariaLabel={`Copy: ${field.name}`}
                disabled={!enabled}
                onCopied={handedOff(["body"])}
              />
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {waiting}
      </p>
      {unrecorded.size > 0 && (
        <p role="alert" className="text-sm font-medium">
          jobkit could not record what you just handed off, as the email changed meanwhile or the
          connection dropped. If you send it, answer Yes when jobkit asks whether you changed
          anything, unless it reads as jobkit drafted it.
        </p>
      )}
    </div>
  );
}
