"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * After the Gmail handoff (review spec, "Handoffs"): "Did you send it?" with
 * Mark sent and Not yet; Mark sent then asks "Did you change anything in
 * Gmail?", and the answer is recorded with the sent status (ledger spec,
 * "Factual edits").
 */
export function MarkSent({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"sent?" | "changed?" | "later">("sent?");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record(changedInGmail: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/sent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changedInGmail }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "You are signed out. Sign in again, then try."
            : "That did not work. Try again.",
        );
      }
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
            <Button onClick={() => setStep("changed?")}>Mark sent</Button>
            <Button variant="outline" onClick={() => setStep("later")}>
              Not yet
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">Did you change anything in Gmail?</p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void record(true)}>
              Yes
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => void record(false)}>
              No
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
