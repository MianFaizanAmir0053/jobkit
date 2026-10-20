"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

type Label = "supported" | "not_supported";

const WORDS: Record<Label, string> = {
  supported: "The facts support it",
  not_supported: "Overstated or not supported",
};

/** One sentence's label: two buttons until it is given, then what was given; `url` takes it. */
export function JudgeLabel({
  id,
  label,
  url = `/api/dev/label/judge/${id}`,
}: {
  id: string;
  label: Label | null;
  url?: string;
}) {
  const [given, setGiven] = useState<Label | null>(label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function give(choice: Label) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: choice }),
      });
      if (response.ok) setGiven(choice);
      else if (response.status === 409) setError("Labelled already: reload to see its label.");
      else setError("Not saved. Try again.");
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (given) return <p className="text-sm">Labelled: {WORDS[given]}.</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {(["supported", "not_supported"] as const).map((choice) => (
          <Button
            key={choice}
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void give(choice)}
          >
            {WORDS[choice]}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
