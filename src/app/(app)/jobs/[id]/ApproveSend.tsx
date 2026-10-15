"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

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

/** The server's latest word on the send, and when it came, by this page's clock. */
type Known = ShownSend & { at: number };

/** How often the page asks how its send stands: often while one is in flight, else now and then. */
const ASK_IN_FLIGHT_MS = 1_500;
const ASK_IDLE_MS = 15_000;
/** How long the page waits for an answer before it says the connection dropped. */
const ANSWER_MS = 15_000;
/** How often the page nudges a send that is due and not yet begun. */
const NUDGE_EVERY_MS = 5_000;

const REFUSALS: Readonly<Record<string, string>> = {
  "gmail-not-connected": "Gmail is not connected. Connect it on the Devices page, then try again.",
  "gmail-refused": "jobkit can no longer use your Gmail. Connect it again on the Devices page.",
  attachment:
    "This post asks for a file besides your CV, which jobkit cannot attach: send it yourself with Open in Gmail.",
  words:
    "This email's words must change before it goes, which jobkit cannot do: send it yourself with Open in Gmail, and change them there.",
  held: "Something still holds this email back. The page now shows what.",
  changed: "The email changed after this page was drawn. The page now shows it as it stands.",
  sending: "jobkit is already sending this email.",
  sent: "This email was already sent.",
  "too-late": "Too late to undo: the send has begun.",
  uncertain:
    "An earlier send may have gone: the page now says so. Check your Gmail Sent folder first.",
};

async function refusalOf(response: Response): Promise<string> {
  const { error } = (await response.json().catch(() => ({}))) as { error?: string };
  return error && Object.hasOwn(REFUSALS, error) ? REFUSALS[error]! : messageFor(response.status);
}

const inFlight = (status: ShownSend["status"] | undefined) =>
  status === "scheduled" || status === "sending";

const keyOf = (send: { id: string; status: string } | null) =>
  send ? `${send.id}-${send.status}` : "none";

/**
 * "Approve & send" (decisions A20): one press, then a confirmation in place
 * of the button with the account it sends from, the address, the subject,
 * the CV it attaches and the flagged sentences and flags the press marks
 * "I checked this"; then ten seconds to Undo. The server is the authority:
 * the control shows the send as the server last said, asking it when drawn,
 * when the page is shown again, every 1.5 seconds while a send is in flight
 * and every 15 otherwise, one question at a time, and the countdown runs
 * from each answer. Undo stays while the server still holds the send as
 * scheduled, so a refused tap or a late nudge never loses it. The server
 * sends when the countdown ends though the page is closed; the page nudges
 * it too, for a server that restarted meanwhile. When the server's word
 * differs from what the page was drawn with, the page is drawn again, once
 * for each word, and this control with it. The page announces each step in
 * its own live region, which outlives this control.
 */
export function ApproveSend({
  jobId,
  kit,
  to,
  subject,
  gmail,
  onLaptop,
  cv,
  approvals,
  held,
  uncertainId,
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
  /** Whether this device can open Devices, where Gmail is connected; a paired phone cannot. */
  onLaptop: boolean;
  /** The CV's file name as the recruiter sees it; null when jobkit cannot find it. */
  cv: string | null;
  /** What the press marks "I checked this": each flagged sentence and flag the page lists. */
  approvals: string[];
  /** Why Approve & send cannot send it now, in the owner's words; null when it can. */
  held: string | null;
  /** The earlier send that may have gone, which the confirmation repeats and the press names. */
  uncertainId: string | null;
  /** The send the page shows, as the server said when the page was drawn. */
  shown: ShownSend | null;
}) {
  const router = useRouter();
  const [known, setKnown] = useState<Known | null>(() =>
    shown ? { ...shown, at: performance.now() } : null,
  );
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the last question went unanswered, so the page cannot tell how the send stands.
  const [unreachable, setUnreachable] = useState(false);
  const decisionInFlight = useSyncExternalStore(onOutboundHold, outboundHeld, () => false);
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  // The server's words the page was drawn again for, so one word never draws it twice.
  const drawnFor = useRef(keyOf(shown));
  const asking = useRef(false);
  const nudgedAt = useRef(0);
  const waiting = inFlight(known?.status);

  // Takes the server's word on the send; the page is drawn again when it differs from the page's.
  function heard(send: ShownSend | null) {
    setKnown(send && { ...send, at: performance.now() });
    const said = keyOf(send);
    if (said !== keyOf(shown) && said !== drawnFor.current) {
      drawnFor.current = said;
      gateChanged(jobId);
      router.refresh();
    }
  }
  const heardInEffect = useEffectEvent(heard);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (stopped || asking.current || document.visibilityState !== "visible") return;
      asking.current = true;
      try {
        const response = await fetch(`/api/jobs/${jobId}/send?kit=${encodeURIComponent(kit)}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(ANSWER_MS),
        });
        if (response.ok && !stopped) {
          heardInEffect(((await response.json()) as { send: ShownSend | null }).send);
        }
        if (!stopped) setUnreachable(!response.ok);
      } catch {
        // Asked again below.
        if (!stopped) setUnreachable(true);
      } finally {
        asking.current = false;
      }
    };
    const loop = async () => {
      await ask();
      if (!stopped) timer = setTimeout(() => void loop(), waiting ? ASK_IN_FLIGHT_MS : ASK_IDLE_MS);
    };
    void loop();
    const shownAgain = () => void ask();
    document.addEventListener("visibilitychange", shownAgain);
    window.addEventListener("pageshow", shownAgain);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shownAgain);
      window.removeEventListener("pageshow", shownAgain);
    };
  }, [jobId, kit, waiting]);

  // The countdown's clock, while a send is scheduled; once it is due, the page nudges it, now and
  // then, until the server begins it.
  useEffect(() => {
    if (known?.status !== "scheduled") return;
    const sendId = known.id;
    const dueAt = known.at + known.leftMs;
    const timer = setInterval(() => {
      const time = performance.now();
      setNow(time);
      if (time < dueAt || time - nudgedAt.current < NUDGE_EVERY_MS) return;
      nudgedAt.current = time;
      void fetch(`/api/jobs/${jobId}/send/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendId }),
        signal: AbortSignal.timeout(ANSWER_MS),
      })
        .then(async (response) => {
          if (response.ok) heardInEffect(((await response.json()) as { send: ShownSend }).send);
        })
        .catch(() => {
          // The server sends it on its own; the page asks how it stands.
        });
    }, 250);
    return () => clearInterval(timer);
  }, [known, jobId]);

  // Focus follows the steps for keyboard and screen-reader users, unless they moved it elsewhere.
  const step = known?.status === "scheduled" ? "counting" : confirming ? "confirm" : "other";
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
        body: JSON.stringify({ kit, to, uncertain: uncertainId }),
        signal: AbortSignal.timeout(ANSWER_MS),
      });
      if (!response.ok) {
        setError(await refusalOf(response));
        setConfirming(false);
        router.refresh();
        return;
      }
      setConfirming(false);
      heard(((await response.json()) as { send: ShownSend }).send);
    } catch {
      // The press may have reached the server: the next question finds out, and brings back Undo.
      setError(
        "The connection dropped. The page shows the email's state as soon as jobkit answers.",
      );
      setConfirming(false);
    } finally {
      release();
      gateChanged(jobId);
      setBusy(false);
    }
  }

  async function undo() {
    if (known === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/send/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendId: known.id }),
        signal: AbortSignal.timeout(ANSWER_MS),
      });
      if (response.ok) {
        heard({ ...known, status: "cancelled", leftMs: 0 });
      } else {
        // Undo stays while the server still holds the send as scheduled; the next answer says.
        setError(await refusalOf(response));
      }
    } catch {
      setError("The connection dropped. Press Undo again.");
    } finally {
      setBusy(false);
    }
  }

  const alert = (
    <>
      {unreachable && inFlight(known?.status) && (
        <p className="text-sm text-muted-foreground">
          jobkit cannot be reached just now, so this page cannot tell how the email stands. It asks
          again every few seconds.
        </p>
      )}
      <p role="alert" className="min-h-5 text-sm text-destructive">
        {error}
      </p>
    </>
  );

  if (known?.status === "scheduled") {
    const left = Math.max(0, Math.ceil((known.at + known.leftMs - now) / 1000));
    return (
      <div ref={box} className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p id={`countdown-${known.id}`} className="text-sm">
          {left > 0 ? (
            <>
              Sending to <span className="font-medium">{to}</span> in {left} second
              {left === 1 ? "" : "s"}…
            </>
          ) : (
            <>
              Sending to <span className="font-medium">{to}</span> now…
            </>
          )}
        </p>
        <div>
          <Button
            ref={undoButton}
            className="min-h-11"
            variant="outline"
            disabled={busy}
            aria-describedby={`countdown-${known.id}`}
            onClick={undo}
          >
            Undo
          </Button>
        </div>
        {alert}
      </div>
    );
  }
  if (known?.status === "sending") {
    return (
      <div ref={box} className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm">Sending from your Gmail…</p>
        {alert}
      </div>
    );
  }
  if (confirming) {
    return (
      <div ref={box} className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
        <p ref={heading} tabIndex={-1} className="font-medium outline-none">
          Send this email now?
        </p>
        {uncertainId !== null && (
          <p className="text-destructive">
            An earlier send may have gone. Check your Gmail Sent folder first: if it went, use Mark
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
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        </div>
        {alert}
      </div>
    );
  }
  const ready = gmail.state === "connected" && cv !== null && held === null && to !== "";
  const devices = onLaptop ? (
    <Link href="/devices" className="inline-flex min-h-11 items-center underline">
      {gmail.state === "refused"
        ? "connect it again on the Devices page"
        : "connect Gmail on the Devices page"}
    </Link>
  ) : (
    "connect it on the laptop, on the Devices page"
  );
  return (
    <div ref={box} className="flex flex-col gap-2">
      <div>
        <Button
          className="min-h-11"
          disabled={!ready || decisionInFlight || busy}
          onClick={() => setConfirming(true)}
        >
          Approve &amp; send
        </Button>
      </div>
      {gmail.state !== "connected" ? (
        <p className="text-sm text-muted-foreground">
          {gmail.state === "refused"
            ? "jobkit can no longer send from your Gmail: "
            : "To send from jobkit, "}
          {devices}.
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
      {alert}
    </div>
  );
}
