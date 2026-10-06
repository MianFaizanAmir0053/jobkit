"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export function RevokeButton({ sessionId, label }: { sessionId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function revoke() {
    if (!window.confirm(`Revoke ${label}? It will have to sign in or pair again.`)) return;
    setBusy(true);
    try {
      await fetch("/api/devices/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      aria-label={`Revoke ${label}`}
      onClick={() => void revoke()}
    >
      Revoke
    </Button>
  );
}
