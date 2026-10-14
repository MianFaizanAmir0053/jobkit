"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Disconnects Gmail: jobkit forgets the connection and revokes its token at Google. */
export function DisconnectGmail({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    if (!window.confirm(`Disconnect ${email}? jobkit will no longer send email from it.`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/gmail/disconnect", { method: "POST" });
      if (!response.ok) setError("That did not work. Try again.");
      router.refresh();
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant="outline"
        className="min-h-11"
        disabled={busy}
        onClick={() => void disconnect()}
      >
        Disconnect
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
