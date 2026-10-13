"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";

import { messageFor } from "./ActionButton";

/** Posts one of the owner's decisions on the kit, then renders the page again with the gate it leaves. */
async function decide(jobId: string, action: object): Promise<string | null> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    return response.ok ? null : messageFor(response.status);
  } catch {
    return "The connection dropped. Try again.";
  }
}

/** The owner types the address or number from the post; it counts once it passes the strict check. */
export function RetypeField({
  jobId,
  kind,
  value,
}: {
  jobId: string;
  kind: "email" | "whatsapp";
  value: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("contact") ?? "");
    setBusy(true);
    setError(await decide(jobId, { kind: "retype", value: typed }));
    setBusy(false);
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void save(event)} className="mt-2 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-sm">
        {kind === "email"
          ? "The address, as the post gives it"
          : "The number, with its country code"}
        <input
          name="contact"
          defaultValue={value ?? ""}
          type={kind === "email" ? "email" : "tel"}
          autoComplete="off"
          spellCheck={false}
          className="w-72 max-w-full rounded-md border border-border bg-transparent px-2 py-1"
        />
      </label>
      <Button type="submit" size="sm" disabled={busy}>
        Use it
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </form>
  );
}

/** A required attachment's tick: the owner ticks it once it is attached in Gmail. */
export function AttachTick({
  jobId,
  name,
  ticked,
}: {
  jobId: string;
  name: string;
  ticked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(await decide(jobId, { kind: "attach", name, ticked: next }));
    setBusy(false);
    router.refresh();
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={ticked}
        disabled={busy}
        onChange={(event) => void toggle(event.currentTarget.checked)}
      />
      Attached: {name}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}
