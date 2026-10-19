"use client";

import { useRouter } from "next/navigation";
import { type MouseEvent, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { gateChanged, holdOutbound } from "../polling";

import { messageFor } from "./ActionButton";
import { handoffsLanded, useUnrecorded } from "./handoffs";

/** How long after "Mark sent" a tap on Yes or No is the same double tap, not an answer. */
const SETTLE_MS = 500;

/**
 * After the Gmail handoff (review spec, "Handoffs"): "Did you send it to
 * <address>?" with Mark sent and Not yet; Mark sent waits for the job's
 * handoffs still in flight to land (at most HANDOFF_MS), says if jobkit
 * could not record one, and then asks "Did you change anything in
 * Gmail?", with Back for a mistaken tap, and the answer is recorded with
 * the sent status (ledger spec, "Factual edits"). The page offers it only
 * once nothing holds the email back, and names the kit and the address it
 * showed: a tap from a page drawn before the address was typed again
 * elsewhere is refused, and the page drawn again. Yes and No sit where Mark
 * sent was, so for half a second after they show a tap on them is taken as
 * the rest of a double tap and ignored.
 */
export function MarkSent({ jobId, kit, to }: { jobId: string; kit: string; to: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"sent?" | "changed?" | "later">("sent?");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether a handoff had not landed by the time Mark sent stopped waiting for it.
  const [late, setLate] = useState(false);
  const unrecorded = useUnrecorded(jobId);
  const askedAt = useRef<number | null>(null);

  // The question waits for the handoffs in flight, so a refused one is said before it is answered.
  async function ask() {
    setBusy(true);
    setError(null);
    const landed = await handoffsLanded(jobId);
    setLate(!landed);
    setBusy(false);
    askedAt.current = performance.now();
    setStep("changed?");
  }

  function answer(changedInGmail: boolean, event: MouseEvent) {
    if (askedAt.current !== null && event.timeStamp - askedAt.current < SETTLE_MS) return;
    void record(changedInGmail);
  }

  async function record(changedInGmail: boolean) {
    setBusy(true);
    setError(null);
    const release = holdOutbound();
    try {
      // What was handed off last is what Mark sent records: one posted since the question lands first.
      await handoffsLanded(jobId);
      const response = await fetch(`/api/jobs/${jobId}/sent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changedInGmail, kit, to }),
      });
      if (!response.ok) setError(messageFor(response.status));
      router.refresh();
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      release();
      gateChanged(jobId);
      setBusy(false);
    }
  }

  if (step === "later") {
    return (
      <p className="text-sm text-muted-foreground">
        Come back and mark it sent once you have.{" "}
        <button
          type="button"
          className="inline-flex min-h-11 items-center underline"
          onClick={() => setStep("sent?")}
        >
          I have sent it
        </button>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {step === "sent?" ? (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">
            {to === "" ? "Did you send it?" : `Did you send it to ${to}?`}
          </p>
          <div className="flex gap-2">
            <Button className="min-h-11" disabled={busy} onClick={() => void ask()}>
              {busy ? "Checking…" : "Mark sent"}
            </Button>
            <Button variant="outline" className="min-h-11" onClick={() => setStep("later")}>
              Not yet
            </Button>
          </div>
        </>
      ) : (
        <>
          {(late || unrecorded.size > 0) && (
            <p role="alert" className="text-sm font-medium">
              {late
                ? "jobkit could not confirm in time that it recorded what you last handed off."
                : "jobkit could not record what you last handed off."}{" "}
              Answer Yes unless the email you sent reads as jobkit drafted it.
            </p>
          )}
          <p className="text-sm">Did you change anything in Gmail?</p>
          <div className="flex gap-2">
            <Button
              className="min-h-11 min-w-11"
              disabled={busy}
              onClick={(event) => answer(true, event)}
            >
              Yes
            </Button>
            <Button
              className="min-h-11 min-w-11"
              disabled={busy}
              variant="outline"
              onClick={(event) => answer(false, event)}
            >
              No
            </Button>
            <Button
              className="min-h-11"
              disabled={busy}
              variant="ghost"
              onClick={() => {
                setError(null);
                setStep("sent?");
              }}
            >
              Back
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
