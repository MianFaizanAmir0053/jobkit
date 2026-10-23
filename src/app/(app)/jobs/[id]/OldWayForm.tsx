"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { BASELINE_ROUTES, type BaselineRoute } from "@/core/ledger/baseline";

import { ROUTE_NAMES } from "../../baseline/routeNames";

/**
 * What the owner names when they applied the old way (ledger spec, "The
 * timing comparison"): how they applied, the company and the role, posted
 * to `url` with `extra`, as Stop on a manual run does and "I applied
 * another way" on a jobkit job that failed or stopped. No route is picked
 * for the owner: a run filed under a route they never chose would skew it.
 */
export function OldWayForm({
  url,
  label,
  extra = {},
  company: initialCompany = "",
  role: initialRole = "",
  done,
}: {
  url: string;
  label: string;
  extra?: Record<string, string>;
  company?: string;
  role?: string;
  /** What a refusal as already recorded means, in the page's words. */
  done: string;
}) {
  const router = useRouter();
  const id = useId();
  const [route, setRoute] = useState<BaselineRoute | null>(null);
  const [company, setCompany] = useState(initialCompany);
  const [role, setRole] = useState(initialRole);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function send() {
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
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...extra, route, company, role }),
      });
      if (!response.ok) {
        setNotice(response.status === 409 ? done : "jobkit could not record it. Try again.");
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
        <Button className="min-h-11" disabled={busy} onClick={() => void send()}>
          {label}
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
