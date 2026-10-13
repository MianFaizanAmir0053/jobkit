"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Copies text for pasting into Gmail or a form; says so for two seconds.
 * Held back, like every outbound control, while the gate has an open reason.
 */
export function CopyButton({
  text,
  label,
  disabled = false,
}: {
  text: string;
  label: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2_000);
  }

  return (
    <Button variant="outline" className="min-h-11" disabled={disabled} onClick={() => void copy()}>
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy it instead" : label}
    </Button>
  );
}
