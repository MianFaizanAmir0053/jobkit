"use client";

import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/time";

import { OldWayForm } from "./OldWayForm";

/**
 * A manual run (ledger spec, "The timing comparison"): the clock runs from
 * the job's start, counted from the elapsed time the server reported, and
 * Stop records the route, company and role the owner applied to the old
 * way.
 */
export function ManualRun({ jobId, elapsedAtLoadMs }: { jobId: string; elapsedAtLoadMs: number }) {
  const [elapsed, setElapsed] = useState(elapsedAtLoadMs);

  useEffect(() => {
    const loadedAt = performance.now();
    const timer = window.setInterval(
      () => setElapsed(elapsedAtLoadMs + performance.now() - loadedAt),
      250,
    );
    return () => window.clearInterval(timer);
  }, [elapsedAtLoadMs]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-3xl font-semibold tabular-nums" aria-live="off">
        {formatDuration(elapsed)}
      </p>
      <OldWayForm
        url={`/api/jobs/${jobId}/stop`}
        label="Stop"
        done="This run is stopped already."
      />
    </div>
  );
}
