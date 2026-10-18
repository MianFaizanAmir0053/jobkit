"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { gateChanged, holdOutbound } from "../polling";

import { decided, forget, wordsAfter } from "./wordsChain";

/** A refused answer in plain words, by its HTTP status. */
export function messageFor(status: number): string {
  if (status === 401) return "You are signed out. Sign in again, then try.";
  if (status === 403) return "This device cannot do that. Sign in again on the laptop.";
  if (status === 409) return "The job has moved on; the page now shows where it stands.";
  return "That did not work. Try again.";
}

/**
 * One of the owner's answers on the job page: it posts to the job's route,
 * then renders the page again from the server, which shows the job's new
 * state. A refusal says what to do in plain words. An answer that can
 * change a kit's gate names the job: while it is in flight the outbound
 * controls wait, and the job's pages in other tabs are told once it lands.
 */
export function ActionButton({
  url,
  label,
  body,
  confirmText,
  variant = "default",
  gateOf,
  ariaLabel,
}: {
  url: string;
  label: string;
  body?: object;
  confirmText?: string;
  variant?: "default" | "outline" | "destructive";
  /** The job whose kit's gate the answer can change. */
  gateOf?: string;
  /** What a screen reader says for the button, where its label alone does not name its job. */
  ariaLabel?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act() {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    const release = gateOf ? holdOutbound() : () => undefined;
    // A decision on the kit names the words this page's own decisions left (wordsChain).
    const shown = (body as { words?: unknown } | undefined)?.words;
    const words = gateOf && typeof shown === "string" ? wordsAfter(gateOf, shown) : null;
    const sent = words === null ? body : { ...body, words };
    try {
      const response = await fetch(url, {
        method: "POST",
        ...(sent
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(sent) }
          : {}),
      });
      if (response.ok && gateOf && words !== null) {
        const answer = (await response.json().catch(() => null)) as { words?: unknown } | null;
        if (typeof answer?.words === "string") decided(gateOf, words, answer.words);
      }
      if (!response.ok) {
        setError(messageFor(response.status));
        // Refused: the page is drawn again with the words the server has, which the next one names.
        if (gateOf) forget(gateOf);
      }
      router.refresh();
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      release();
      if (gateOf) gateChanged(gateOf);
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={variant}
        className="min-h-11"
        disabled={busy}
        aria-label={ariaLabel}
        onClick={() => void act()}
      >
        {label}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
