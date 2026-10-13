"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";

export interface LabelValues {
  company: string;
  role: string;
  route: string;
  contact: string;
  eligibility: string;
  must: string[];
  cropShowsContact: boolean | null;
}

const ELIGIBILITY = ["eligible", "unclear", "likely_ineligible"] as const;

const FIELD = "w-full rounded-md border border-border bg-transparent px-2 py-1";

/**
 * One case's labels (evals spec, "Labelling"): company, role, route, the
 * exact address or number, the eligibility outcome, the must-have
 * requirements and, for a case with a crop, whether it shows the contact.
 * Saved to the case's labels.json; filled from pre-labels only where the
 * page allows. Nothing starts chosen: each choice must be made.
 */
export function LabelForm({
  caseId,
  routes,
  initial,
  suggested,
  hasCrop,
}: {
  caseId: string;
  routes: readonly string[];
  initial: LabelValues;
  suggested: boolean;
  hasCrop: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(
    suggested ? "Filled from the pre-labels: check every field before you save." : null,
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const crop = text("crop");
    const labels = {
      company: text("company"),
      role: text("role"),
      route: text("route"),
      contact: text("contact"),
      eligibility: text("eligibility"),
      must: text("must")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      cropShowsContact: hasCrop ? crop === "yes" : null,
    };
    setBusy(true);
    try {
      const response = await fetch(`/api/dev/label/${caseId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(labels),
      });
      setNote(response.ok ? "Saved." : "That did not save. Check the fields and try again.");
      if (response.ok) router.refresh();
    } catch {
      setNote("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const crop =
    initial.cropShowsContact === true ? "yes" : initial.cropShowsContact === false ? "no" : "";

  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Company
        <input name="company" defaultValue={initial.company} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1">
        Role
        <input name="role" defaultValue={initial.role} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1">
        Route
        <select name="route" defaultValue={initial.route} required className={FIELD}>
          <option value="" disabled>
            Choose the route
          </option>
          {routes.map((route) => (
            <option key={route} value={route}>
              {route}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        The exact address or number (empty when the route has none)
        <input name="contact" defaultValue={initial.contact} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1">
        Eligibility
        <select name="eligibility" defaultValue={initial.eligibility} required className={FIELD}>
          <option value="" disabled>
            Choose the outcome
          </option>
          {ELIGIBILITY.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Must-have requirements, one a line, as the post words them
        <textarea name="must" defaultValue={initial.must.join("\n")} rows={5} className={FIELD} />
      </label>
      {hasCrop && (
        <label className="flex flex-col gap-1">
          Does the crop above show the whole address or number?
          <select name="crop" defaultValue={crop} required className={FIELD}>
            <option value="" disabled>
              Choose
            </option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          Save labels
        </Button>
        {note && (
          <p role="status" className="text-muted-foreground">
            {note}
          </p>
        )}
      </div>
    </form>
  );
}

/** Moves a screenshot from the pool into this case. */
export function AdoptButton({ caseId, file }: { caseId: string; file: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function adopt() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/dev/label/${caseId}/adopt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      if (response.ok) router.refresh();
      else setError("It could not be moved.");
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void adopt()}>
        Add to this case
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
