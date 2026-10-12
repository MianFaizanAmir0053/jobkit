"use client";

import { useRouter } from "next/navigation";
import { type MouseEvent, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { messageFor } from "./ActionButton";

/** How long after "Mark sent" a tap on Yes or No is the same double tap, not an answer. */
const SETTLE_MS = 500;

/**
 * After the Gmail handoff (review spec, "Handoffs"): "Did you send it?" with
 * Mark sent and Not yet; Mark sent then asks "Did you change anything in
 * Gmail?", with Back for a mistaken tap, since a sent kit cannot be taken
 * back yet, and the answer is recorded with the sent status (ledger spec,
 * "Factual edits"). Yes and No sit where Mark sent was, so for half a
 * second a tap on them is taken as the rest of a double tap and ignored.
 */
export function MarkSent({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"sent?" | "changed?" | "later">("sent?");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askedAt = useRef<number | null>(null);

  function answer(changedInGmail: boolean, event: MouseEvent) {
    if (askedAt.current !== null && event.timeStamp - askedAt.current < SETTLE_MS) return;
    void record(changedInGmail);
  }

  async function record(changedInGmail: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/sent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changedInGmail }),
      });
      if (!response.ok) setError(messageFor(response.status));
      router.refresh();
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "later") {
    return (
      <p className="text-sm text-muted-foreground">
        Come back and mark it sent once you have.{" "}
        <button type="button" className="underline" onClick={() => setStep("sent?")}>
          I have sent it
        </button>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {step === "sent?" ? (
        <>
          <p className="text-sm">Did you send it?</p>
          <div className="flex gap-2">
            <Button
              onClick={(event) => {
                askedAt.current = event.timeStamp;
                setStep("changed?");
              }}
            >
              Mark sent
            </Button>
            <Button variant="outline" onClick={() => setStep("later")}>
              Not yet
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">Did you change anything in Gmail?</p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={(event) => answer(true, event)}>
              Yes
            </Button>
            <Button disabled={busy} variant="outline" onClick={(event) => answer(false, event)}>
              No
            </Button>
            <Button
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
