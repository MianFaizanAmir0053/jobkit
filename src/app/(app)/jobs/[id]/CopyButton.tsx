"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Copies text for pasting into Gmail or a form; says so for two seconds.
 * Held back, like every outbound control, while the gate has an open reason.
 * When the clipboard refuses, the text shows to select and copy by hand,
 * which hands it off as a copy does.
 */
export function CopyButton({
  text,
  label,
  disabled = false,
  onCopied,
  ariaLabel,
}: {
  text: string;
  label: string;
  /** What a screen reader says, where the label alone does not name what is copied. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Told once the text is on the clipboard: a handoff. */
  onCopied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied">("idle");
  // The words the clipboard refused, shown to copy by hand while they are still the words to copy.
  const [failedFor, setFailedFor] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      onCopied?.();
      setTimeout(() => setState("idle"), 2_000);
    } catch {
      // Shown to copy by hand, it is handed off all the same.
      setFailedFor(text);
      onCopied?.();
    }
  }

  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      <Button
        variant="outline"
        className="min-h-11"
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => void copy()}
      >
        {state === "copied" ? "Copied" : label}
      </Button>
      {failedFor === text && !disabled && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            jobkit could not copy it: select it here and copy it yourself.
          </span>
          <textarea
            readOnly
            value={text}
            rows={4}
            onFocus={(event) => event.currentTarget.select()}
            className="w-80 max-w-full rounded-md border border-border bg-background p-2"
          />
        </label>
      )}
    </span>
  );
}
