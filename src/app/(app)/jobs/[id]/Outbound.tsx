"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { buttonVariants } from "@/components/ui/button";

import { browserPage, readGate, watchGate } from "../polling";

import { CopyButton } from "./CopyButton";

/**
 * The kit's outbound controls (review spec, "The outbound gate"): Open in
 * Gmail and the copy buttons. The page draws them open only when its gate
 * is, and they open only while the server agrees for the kit the page
 * shows, asked when they are drawn and again as polling.ts says. So a page
 * drawn before the gate closed, in another tab, on the other device or
 * brought back by Back, never sends; one that no longer agrees is drawn
 * again. Clicking never waits for the server: the handoff happens inside
 * the click.
 */
export function Outbound({
  jobId,
  kit,
  open,
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
  /** Whether the kit is an email: Gmail's control shows, held or not. */
  email: boolean;
  /** Gmail's compose link, for an email kit whose gate is open; null otherwise. */
  gmailHref: string | null;
  subject: string;
  body: string;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(
    () =>
      watchGate(
        () => readGate(jobId),
        (answer) => {
          const agrees = answer !== null && answer.kit === kit && answer.open === open;
          setConfirmed(open && agrees);
          if (answer !== null && !agrees) router.refresh();
        },
        browserPage(),
      ),
    [jobId, kit, open, router],
  );

  const enabled = open && confirmed;
  return (
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
  );
}
