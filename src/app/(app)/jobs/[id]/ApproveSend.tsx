"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

import { gateChanged, holdOutbound, onOutboundHold, outboundHeld } from "../polling";

import { messageFor } from "./ActionButton";

/** A send as the page and the send routes give it. */
export interface ShownSend {
  id: string;
  status: "scheduled" | "cancelled" | "sending" | "sent" | "failed" | "unknown";
  /** What is left of its countdown, by the server's clock, as it was read. */
  leftMs: number;
}

/** How often the page asks how its send stands: often while one is in flight, else now and then. */
const ASK_IN_FLIGHT_MS = 1_500;
const ASK_IDLE_MS = 15_000;
/** How long the page waits for an answer before it says the connection dropped. */
const ANSWER_MS = 15_000;

const REFUSALS: Readonly<Record<string, string>> = {
  "gmail-not-connected": "Gmail is not connected. Connect it on the Devices page, then try again.",
  "gmail-refused": "jobkit can no longer use your Gmail. Connect it again on the Devices page.",
  attachment:
    "This post asks for a file besides your CV, which jobkit cannot attach: send it yourself with Open in Gmail.",
  held: "Something still holds this email back. The page now shows what.",
  changed: "The email changed after this page was drawn. The page now shows it as it stands.",
  sending: "jobkit is already sending this email.",
  sent: "This email was already sent.",
  "too-late": "Too late to undo: Gmail has it.",
};

async function refusalOf(response: Response): Promise<string> {
  const { error } = (await response.json().catch(() => ({}))) as { error?: string };
  return error && Object.hasOwn(REFUSALS, error) ? REFUSALS[error]! : messageFor(response.status);
}

const inFlight = (status: ShownSend["status"] | undefined) =>
  status === "scheduled" || status === "sending";

/**
 * "Approve & send" (decisions A20): one press, then a confirmation in place
 * of the button with the account it sends from, the address, the subject,
 * the CV it attaches and the flagged sentences and flags the press marks
 * "I checked this"; then ten seconds to Undo while the page counts down.
 * The server sends it when the countdown ends though the page is closed;
 * the page nudges it too, for a server that restarted meanwhile. Like the
 * other outbound controls it asks the server how its send stands when it
 * is drawn, when the page is shown again, and while it waits, and draws the
 * page again whenever the server says otherwise; it waits while a decision
 * from this tab is in flight. The job page draws it again for each send it
 * shows, so it never keeps an earlier send's steps.
 */
export function ApproveSend({
  jobId,
  kit,
  to,
  subject,
  gmail,
  cv,
  approvals,
  held,
  shown,
}: {
  jobId: string;
  /** The kit the page shows. */
  kit: string;
  /** The address the page shows the email going to; empty until there is one. */
  to: string;
  subject: string;
  /** The Gmail account jobkit sends from, and whether jobkit can still use it. */
  gmail: { state: "connected" | "not-connected" | "refused"; email: string | null };
  /** The CV's file name as the recruiter sees it; null when jobkit cannot find it. */
  cv: string | null;
  /** What the press marks "I checked this": each flagged sentence and flag the page lists. */
  approvals: string[];
  /** Why Approve & send cannot send it now, in the owner's words; null when it can. */
  held: string | null;
  /** The send the page shows, as the server last said. */
  shown: ShownSend | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "confirm" | "counting" | "sending">(
    shown?.status === "scheduled" ? "counting" : shown?.status === "sending" ? "sending" : "idle",
  );
  // The send this press started, until the page is drawn again with it.
  const [pressed, setPressed] = useState<ShownSend | null>(null);
  const counting = pressed ?? (shown?.status === "scheduled" ? shown : null);
  const [left, setLeft] = useState(Math.ceil((counting?.leftMs ?? 0) / 1000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const decisionInFlight = useSyncExternalStore(onOutboundHold, outboundHeld, () => false);
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const waiting = inFlight(shown?.status) || step === "counting" || step === "sending";

  // The server is the authority: when its send is not the one the page shows, the page is drawn
  // again, and this control with it.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/jobs/${jobId}/send`, {
            cache: "no-store",
            signal: AbortSignal.timeout(ANSWER_MS),
          });
          if (response.ok) {
            const { send } = (await response.json()) as { send: ShownSend | null };
            const known = pressed ?? shown;
            if (!stopped && (send?.id !== known?.id || send?.status !== known?.status)) {
              router.refresh();
            }
          }
        } catch {
          // Asked again below.
        }
      }
      if (!stopped) timer = setTimeout(() => void ask(), waiting ? ASK_IN_FLIGHT_MS : ASK_IDLE_MS);
    };
    timer = setTimeout(() => void ask(), waiting ? ASK_IN_FLIGHT_MS : 0);
    const shownAgain = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void ask();
    };
    document.addEventListener("visibilitychange", shownAgain);
    window.addEventListener("pageshow", shownAgain);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shownAgain);
      window.removeEventListener("pageshow", shownAgain);
    };
  }, [jobId, shown, pressed, waiting, router]);

  // The countdown, from what the server said was left; at its end the page nudges the send.
  useEffect(() => {
    if (step !== "counting" || counting === null) return;
    const ends = performance.now() + counting.leftMs;
    const timer = setInterval(
      () => setLeft(Math.max(0, Math.ceil((ends - performance.now()) / 1000))),
      250,
    );
    const due = setTimeout(() => {
      setStep("sending");
      setSaid("Sending from your Gmail.");
      void fetch(`/api/jobs/${jobId}/send/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendId: counting.id }),
      }).catch(() => {
        // The server sends it on its own; the page asks how it went.
      });
    }, counting.leftMs);
    return () => {
      clearInterval(timer);
      clearTimeout(due);
    };
  }, [step, counting, jobId]);

  // Focus follows the steps for keyboard and screen-reader users, unless they moved it elsewhere.
  useEffect(() => {
    const active = document.activeElement;
    const ours = active === document.body || active === null || box.current?.contains(active);
    if (!ours) return;
    if (step === "confirm") heading.current?.focus();
    if (step === "counting") undoButton.current?.focus();
  }, [step]);

  async function press() {
    setBusy(true);
    setError(null);
    const release = holdOutbound();
    try {
      const response = await fetch(`/api/jobs/${jobId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kit, to }),
        signal: AbortSignal.timeout(ANSWER_MS),
      });
      if (!response.ok) {
        setError(await refusalOf(response));
        setStep("idle");
        router.refresh();
        return;
      }
      const { send } = (await response.json()) as { send: ShownSend };
      setPressed(send);
      setLeft(Math.ceil(send.leftMs / 1000));
      setStep("counting");
      setSaid(`Sending in ${Math.ceil(send.leftMs / 1000)} seconds. Undo stops it.`);
      router.refresh();
    } catch {
      // The press may have reached the server: the page asks it.
      setError("The connection dropped. The page now shows whether the email is sending.");
      setStep("idle");
      router.refresh();
    } finally {
      release();
      gateChanged(jobId);
      setBusy(false);
    }
  }

  async function undo() {
    const send = counting;
    if (send === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/send/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendId: send.id }),
        signal: AbortSignal.timeout(ANSWER_MS),
      });
      if (!response.ok) {
        setError(await refusalOf(response));
        setStep("sending");
      } else {
        setSaid("Stopped: nothing was sent.");
      }
      gateChanged(jobId);
      router.refresh();
    } catch {
      setError("The connection dropped. Press Undo again.");
    } finally {
      setBusy(false);
    }
  }

  const status = (
    <>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
      <p role="alert" className="min-h-5 text-sm text-destructive">
        {error}
      </p>
    </>
  );

  if (step === "counting") {
    return (
      <div ref={box} className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm">
          Sending to <span className="font-medium">{to}</span> in {left} second
          {left === 1 ? "" : "s"}…
        </p>
        <div>
          <Button
            ref={undoButton}
            className="min-h-11"
            variant="outline"
            disabled={busy}
            onClick={undo}
          >
            Undo
          </Button>
        </div>
        {status}
      </div>
    );
  }
  if (step === "sending") {
    return (
      <div ref={box} className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm">Sending from your Gmail…</p>
        {status}
      </div>
    );
  }
  if (step === "confirm") {
    return (
      <div ref={box} className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
        <p ref={heading} tabIndex={-1} className="font-medium outline-none">
          Send this email now?
        </p>
        {shown?.status === "unknown" && (
          <p className="text-destructive">
            Your last send may have gone. Check your Gmail Sent folder first: if it went, use Mark
            sent instead.
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
          <dt className="text-muted-foreground">From</dt>
          <dd>{gmail.email}</dd>
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
            <p>Pressing Send marks these as checked by you, even if you then press Undo:</p>
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
          <Button className="min-h-11" disabled={busy || decisionInFlight} onClick={press}>
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
  const ready = gmail.state === "connected" && cv !== null && held === null && to !== "";
  return (
    <div ref={box} className="flex flex-col gap-2">
      <div>
        <Button
          className="min-h-11"
          disabled={!ready || decisionInFlight}
          onClick={() => setStep("confirm")}
        >
          Approve &amp; send
        </Button>
      </div>
      {gmail.state !== "connected" ? (
        <p className="text-sm text-muted-foreground">
          {gmail.state === "refused"
            ? "jobkit can no longer send from your Gmail: "
            : "To send from jobkit, "}
          <Link href="/devices" className="inline-flex min-h-11 items-center underline">
            {gmail.state === "refused"
              ? "connect it again on the Devices page"
              : "connect Gmail on the Devices page"}
          </Link>
          .
        </p>
      ) : held !== null ? (
        <p className="text-sm text-muted-foreground">{held}</p>
      ) : cv === null ? (
        <p className="text-sm text-muted-foreground">
          jobkit cannot find the CV this email was written with: seed that profile again, or send it
          yourself with Open in Gmail.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sends from {gmail.email} with your CV and signature, after ten seconds to undo.
        </p>
      )}
      {status}
    </div>
  );
}
