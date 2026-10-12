"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

function messageFor(status: number): string {
  if (status === 401) return "You are signed out. Sign in again, then try.";
  if (status === 403) return "This device cannot do that. Sign in again on the laptop.";
  if (status === 409) return "The job has moved on; the page now shows where it stands.";
  return "That did not work. Try again.";
}

/**
 * One of the owner's answers on the job page: it posts to the job's route,
 * then renders the page again from the server, which shows the job's new
 * state. A refusal says what to do in plain words.
 */
export function ActionButton({
  url,
  label,
  body,
  confirmText,
  variant = "default",
}: {
  url: string;
  label: string;
  body?: object;
  confirmText?: string;
  variant?: "default" | "outline" | "destructive";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act() {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        ...(body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (!response.ok) setError(messageFor(response.status));
      router.refresh();
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant={variant} disabled={busy} onClick={() => void act()}>
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
