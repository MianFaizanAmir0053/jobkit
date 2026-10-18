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
 * Gmail and the copy buttons. The page draws them open only when its gate
 * is, and they open only while the server agrees on what the page shows:
 * the kit, its gate, the address it goes to and whether the owner skipped
 * the job, asked when they are drawn and again as polling.ts says. The
 * answer is forgotten the moment the page is hidden, while a decision from
 * this tab is in flight, and when a decision is made in another tab of this
 * browser, so a page drawn before the gate closed or the address was typed
 * again, brought back by Back or left open in a tab, waits for a new answer;
 * open on the other device, it learns within one check, 15 seconds at most.
 * One that no longer agrees is drawn again, a skip or its taking back
 * included, though the gate stays closed throughout. Clicking never waits
 * for the server: the handoff happens inside the click.
 */
export function Outbound({
  jobId,
  kit,
  open,
  to,
  skipped,
  email,
  gmailHref,
  subject,
  body,
}: {
  jobId: string;
  /** The kit the page shows. */
  kit: string;
  /** Whether the page's gate is open. */
  open: boolean;
  /** The address or number the page shows the kit going to; null for a route with none. */
  to: string | null;
  /** Whether the page shows the job skipped. */
  skipped: boolean;
  /** Whether the kit is an email: Gmail's control shows, held or not. */
  email: boolean;
  /** Gmail's compose link, for an email kit whose gate is open; null otherwise. */
  gmailHref: string | null;
  subject: string;
  body: string;
}) {
  const router = useRouter();
  const shown = `${kit}\n${String(open)}\n${to ?? ""}\n${String(skipped)}`;
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
          if (confirms(answer, { kit, open, to, skipped })) {
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
    [jobId, kit, open, to, skipped, shown, router],
  );

  const enabled = open && confirmed === shown && !held;
  const waiting = !open
    ? ""
    : held
      ? "Saving your change first: the buttons wait for it."
      : confirmed === shown
        ? ""
        : unreachable
          ? "jobkit cannot be reached to confirm that nothing holds this email back, so the buttons wait. It asks again every 15 seconds."
          : "Checking that nothing holds this email back…";
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
        <CopyButton text={subject} label="Copy subject" disabled={!enabled} />
        <CopyButton text={body} label="Copy email" disabled={!enabled} />
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {waiting}
      </p>
    </div>
  );
}
