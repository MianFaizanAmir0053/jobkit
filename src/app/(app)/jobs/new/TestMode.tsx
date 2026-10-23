"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Test mode on New job (ledger spec, "Test jobs"): for an hour, every job
 * started here or shared to jobkit is a test job, which never counts, so a
 * device check or a spike leaves the timing comparison alone. `until` is
 * when it ends, in the owner's words, while it is on.
 */
export function TestMode({ until }: { until: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function turn(on: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/measurement/test-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      if (!response.ok) setNotice("jobkit could not change test mode. Try again.");
      router.refresh();
    } catch {
      setNotice("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-2 rounded-md border p-3 text-sm">
      {until ? (
        <p>
          Test mode is on until {until}: every job you start, or share to jobkit, is a test job,
          which never counts.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Trying jobkit out? Test mode makes the next hour&apos;s jobs test jobs, which never count.
        </p>
      )}
      <div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => void turn(until === null)}
        >
          {until ? "End test mode" : "Turn on test mode for an hour"}
        </Button>
      </div>
      {notice && (
        <p role="alert" className="text-destructive">
          {notice}
        </p>
      )}
    </div>
  );
}
