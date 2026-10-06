"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { BASELINE_ROUTES, type BaselineRoute } from "@/core/ledger/baseline";
import { formatDuration } from "@/lib/time";

import { ROUTE_NAMES } from "./routeNames";

/**
 * Start, then Stop with the route, company and role. The server keeps the
 * times; this only shows the running clock, counted from the elapsed time
 * the server reported, so the laptop's clock does not matter.
 */
export function Stopwatch({ elapsedAtLoadMs }: { elapsedAtLoadMs: number | null }) {
  const router = useRouter();
  const running = elapsedAtLoadMs !== null;
  const [elapsed, setElapsed] = useState(elapsedAtLoadMs ?? 0);
  const [route, setRoute] = useState<BaselineRoute>("email");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (elapsedAtLoadMs === null) return;
    const loadedAt = performance.now();
    const timer = window.setInterval(
      () => setElapsed(elapsedAtLoadMs + performance.now() - loadedAt),
      250,
    );
    return () => window.clearInterval(timer);
  }, [elapsedAtLoadMs]);

  async function send(action: "start" | "stop" | "discard", body?: object) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/baseline/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (action === "stop" && response.status === 400) {
        setNotice("Say the route, the company and the role.");
        return;
      }
      if (action === "stop" && response.ok) {
        const { durationMs } = (await response.json()) as { durationMs: number };
        setNotice(`Recorded ${formatDuration(durationMs)}.`);
        setCompany("");
        setRole("");
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!running) {
    return (
      <div className="mt-6">
        <Button size="lg" disabled={busy} onClick={() => void send("start")}>
          Start
        </Button>
        {notice && (
          <p role="status" className="mt-3 text-sm">
            {notice}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="mt-6 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send("stop", { route, company, role });
      }}
    >
      <p
        role="timer"
        aria-label="Time so far"
        className="font-mono text-5xl font-semibold tabular-nums text-primary"
      >
        {formatDuration(elapsed)}
      </p>
      <fieldset className="mt-4">
        <legend className="text-sm text-muted-foreground">Route</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {BASELINE_ROUTES.map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="route"
                className="accent-primary"
                value={value}
                checked={route === value}
                onChange={() => setRoute(value)}
              />
              {ROUTE_NAMES[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor="baseline-company" className="mt-4 block text-sm text-muted-foreground">
        Company
      </label>
      <input
        id="baseline-company"
        value={company}
        onChange={(event) => setCompany(event.target.value)}
        maxLength={200}
        className="mt-1 w-full rounded-lg border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <label htmlFor="baseline-role" className="mt-3 block text-sm text-muted-foreground">
        Role
      </label>
      <input
        id="baseline-role"
        value={role}
        onChange={(event) => setRole(event.target.value)}
        maxLength={200}
        className="mt-1 w-full rounded-lg border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="mt-4 flex gap-2">
        <Button type="submit" size="lg" disabled={busy}>
          Stop
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Throw away this run? Nothing is recorded.")) void send("discard");
          }}
        >
          Discard
        </Button>
      </div>
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
    </form>
  );
}
