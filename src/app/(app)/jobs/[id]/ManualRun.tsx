"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { BASELINE_ROUTES, type BaselineRoute } from "@/core/ledger/baseline";
import { formatDuration } from "@/lib/time";

import { ROUTE_NAMES } from "../../baseline/routeNames";

/**
 * A manual run (ledger spec, "The timing comparison"): the clock runs from
 * the job's start, counted from the elapsed time the server reported, and
 * Stop records the route, company and role the owner applied to the old
 * way.
 */
export function ManualRun({ jobId, elapsedAtLoadMs }: { jobId: string; elapsedAtLoadMs: number }) {
  const router = useRouter();
  const id = useId();
  const [elapsed, setElapsed] = useState(elapsedAtLoadMs);
  // No route is picked for the owner: a run filed under a route they never chose would skew it.
  const [route, setRoute] = useState<BaselineRoute | null>(null);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const loadedAt = performance.now();
    const timer = window.setInterval(
      () => setElapsed(elapsedAtLoadMs + performance.now() - loadedAt),
      250,
    );
    return () => window.clearInterval(timer);
  }, [elapsedAtLoadMs]);

  async function stop() {
    if (route === null) {
      setNotice("Say how you applied.");
      return;
    }
    if (company.trim() === "" || role.trim() === "") {
      setNotice("Say the company and the role.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route, company, role }),
      });
      if (!response.ok) {
        setNotice(
          response.status === 409
            ? "This run is stopped already."
            : "jobkit could not record it. Try again.",
        );
      }
      router.refresh();
    } catch {
      setNotice("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-3xl font-semibold tabular-nums" aria-live="off">
        {formatDuration(elapsed)}
      </p>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-muted-foreground">How you applied</legend>
        {BASELINE_ROUTES.map((each) => (
          <label key={each} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={`${id}-route`}
              value={each}
              checked={route === each}
              onChange={() => setRoute(each)}
            />
            {ROUTE_NAMES[each]}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1">
        Company
        <input
          className="min-h-11 rounded-md border border-input bg-transparent px-3"
          value={company}
          maxLength={200}
          onChange={(event) => setCompany(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        Role
        <input
          className="min-h-11 rounded-md border border-input bg-transparent px-3"
          value={role}
          maxLength={200}
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      <div>
        <Button className="min-h-11" disabled={busy} onClick={() => void stop()}>
          Stop
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
