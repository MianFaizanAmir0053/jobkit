"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { gateChanged, holdOutbound } from "../polling";

import { messageFor } from "./ActionButton";

/** A send as the send routes give it. */
export interface ShownSend {
  id: string;
  status: "scheduled" | "cancelled" | "sending" | "sent" | "failed";
  /** What is left of its countdown, by the server's clock, as it was read. */
  leftMs: number;
}

/** How often the page asks how a send it nudged went, and for how long. */
const POLL_MS = 1_500;
const POLL_FOR_MS = 60_000;

const REFUSALS: Readonly<Record<string, string>> = {
  "gmail-not-connected": "Gmail is not connected. Connect it on the Devices page, then try again.",
  held: "Something still holds this email back. The page now shows what.",
  changed: "The email changed after this page was drawn. The page now shows it as it stands.",
  sending: "jobkit is already sending this email.",
  sent: "This email was already sent.",
  "too-late": "Too late to undo: the email is on its way.",
};

async function refusalOf(response: Response): Promise<string> {
  const { error } = (await response.json().catch(() => ({}))) as { error?: string };
  return (error && REFUSALS[error]) ?? messageFor(response.status);
}

/**
 * "Approve & send" (decisions A20): one press, then a confirmation in place
 * of the button with the address, the subject, the account it sends from,
 * the CV it attaches and the flagged sentences and flags the press marks
 * "I checked this"; then ten seconds to Undo while the page counts down,
 * and the page asks how it went until the server says. The server sends it
 * when the countdown ends though the page is closed; the page nudges it
 * too, for a server that restarted meanwhile. Either way it goes once. A
 * page drawn while a send counts down or sends picks it up where it is.
 */
export function ApproveSend({
  jobId,
  kit,
  to,
  subject,
  from,
  cv,
  approvals,
  held,
  live,
}: {
  jobId: string;
  /** The kit the page shows. */
  kit: string;
  /** The address the page shows the email going to; empty until there is one. */
  to: string;
  subject: string;
  /** The Gmail account jobkit sends from; null while Gmail is not connected. */
  from: string | null;
  /** The CV's file name as the recruiter sees it; null when jobkit cannot find it. */
  cv: string | null;
  /** What the press marks "I checked this": each flagged sentence and flag the page lists. */
  approvals: string[];
  /** Whether a reason the press does not settle holds the email. */
  held: boolean;
  /** The send counting down or sending as the page was drawn. */
  live: ShownSend | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "confirm" | "counting" | "sending">(
    live === null ? "idle" : live.status === "scheduled" ? "counting" : "sending",
  );
  const [send, setSend] = useState<ShownSend | null>(live);
  const [left, setLeft] = useState(Math.ceil((live?.leftMs ?? 0) / 1000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The countdown, from what the server said was left; at its end the page nudges the send.
  useEffect(() => {
    if (step !== "counting" || send === null) return;
    const ends = performance.now() + send.leftMs;
    const timer = setInterval(
      () => setLeft(Math.max(0, Math.ceil((ends - performance.now()) / 1000))),
      250,
    );
    const due = setTimeout(() => {
      setStep("sending");
      void fetch(`/api/jobs/${jobId}/send/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendId: send.id }),
      }).catch(() => {
        // The server sends it on its own; the page asks how it went below.
      });
    }, send.leftMs);
    return () => {
      clearInterval(timer);
      clearTimeout(due);
    };
  }, [step, send, jobId]);

  // While it sends, the page asks how it went until the server says, a minute at most.
  useEffect(() => {
    if (step !== "sending") return;
    let stopped = false;
    const started = Date.now();
    const ask = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`/api/jobs/${jobId}/send`, { cache: "no-store" });
        const { send: now } = (await response.json()) as { send: ShownSend | null };
        if (now && now.status !== "scheduled" && now.status !== "sending") {
          gateChanged(jobId);
          router.refresh();
          return;
        }
      } catch {
        // Asked again below.
      }
      if (Date.now() - started > POLL_FOR_MS) {
        setError("jobkit has not heard back from Gmail yet. Reload the page in a minute.");
        return;
      }
      setTimeout(() => void ask(), POLL_MS);
    };
    const first = setTimeout(() => void ask(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [step, jobId, router]);

  async function press() {
    setBusy(true);
    setError(null);
    const release = holdOutbound();
    try {
      const response = await fetch(`/api/jobs/${jobId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kit, to }),
      });
      if (!response.ok) {
        setError(await refusalOf(response));
        setStep("idle");
        router.refresh();
        return;
      }
      const { send: scheduled } = (await response.json()) as { send: ShownSend };
      setSend(scheduled);
      setLeft(Math.ceil(scheduled.leftMs / 1000));
      setStep("counting");
    } catch {
      setError("The connection dropped, so nothing was sent. Try again.");
    } finally {
      release();
      gateChanged(jobId);
      setBusy(false);
    }
  }

  async function undo() {
    if (send === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/send/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendId: send.id }),
      });
      if (response.ok) {
        setStep("idle");
        gateChanged(jobId);
        router.refresh();
      } else {
        setError(await refusalOf(response));
        setStep("sending");
      }
    } catch {
      setError("The connection dropped. Press Undo again.");
    } finally {
      setBusy(false);
    }
  }

  const status = (
    <p role="alert" className="min-h-5 text-sm text-destructive">
      {error}
    </p>
  );

  if (step === "counting") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm" aria-live="polite">
          Sending to <span className="font-medium">{to}</span> in {left} second
          {left === 1 ? "" : "s"}…
        </p>
        <div>
          <Button className="min-h-11" variant="outline" disabled={busy} onClick={undo}>
            Undo
          </Button>
        </div>
        {status}
      </div>
    );
  }
  if (step === "sending") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm" aria-live="polite">
          Sending from your Gmail…
        </p>
        {status}
      </div>
    );
  }
  if (step === "confirm") {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
        <p className="font-medium">Send this email now?</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
          <dt className="text-muted-foreground">From</dt>
          <dd>{from}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd>{to}</dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd>{subject}</dd>
          <dt className="text-muted-foreground">Attached</dt>
          <dd>{cv}</dd>
        </dl>
        <p className="text-muted-foreground">Your signature goes under the email.</p>
        {approvals.length > 0 && (
          <div>
            <p>Sending also marks these as checked by you:</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground [overflow-wrap:anywhere]">
              {approvals.map((approval, i) => (
                <li key={i}>{approval}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-muted-foreground">
          You have ten seconds to undo it once you press Send.
        </p>
        <div className="flex gap-2">
          <Button className="min-h-11" disabled={busy} onClick={press}>
            Send
          </Button>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setStep("idle");
            }}
          >
            Cancel
          </Button>
        </div>
        {status}
      </div>
    );
  }
  const ready = from !== null && cv !== null && !held && to !== "";
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button className="min-h-11" disabled={!ready} onClick={() => setStep("confirm")}>
          Approve &amp; send
        </Button>
      </div>
      {from === null ? (
        <p className="text-sm text-muted-foreground">
          To send from jobkit,{" "}
          <Link href="/devices" className="underline">
            connect Gmail on the Devices page
          </Link>
          .
        </p>
      ) : cv === null ? (
        <p className="text-sm text-muted-foreground">
          jobkit cannot find the CV this email was written with. Seed your profile again.
        </p>
      ) : held ? (
        <p className="text-sm text-muted-foreground">
          Approve &amp; send marks the sentences and flags above as checked, but the other reasons
          listed need you first.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sends from {from} with your CV and signature, after ten seconds to undo.
        </p>
      )}
      {status}
    </div>
  );
}
