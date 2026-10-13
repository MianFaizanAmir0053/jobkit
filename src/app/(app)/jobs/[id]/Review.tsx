"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";

import { messageFor } from "./ActionButton";

/**
 * Posts one of the owner's decisions on the kit the page shows, then renders
 * the page again with the gate it leaves. A page drawn on another kit is
 * refused, and drawn again.
 */
async function decide(jobId: string, kit: string, action: object): Promise<string | null> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, kit }),
    });
    return response.ok ? null : messageFor(response.status);
  } catch {
    return "The connection dropped. Try again.";
  }
}

/**
 * The owner types the address or number as they read it in the post, never
 * from jobkit's own reading; it counts once it passes the strict check.
 */
export function RetypeField({
  jobId,
  kit,
  kind,
  value,
}: {
  jobId: string;
  kit: string;
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
    setError(await decide(jobId, kit, { kind: "retype", value: typed }));
    setBusy(false);
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void save(event)} className="mt-2 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-sm">
        {kind === "email"
          ? "The address, as you read it in the post"
          : "The number, as you read it in the post, with its country code"}
        <input
          name="contact"
          defaultValue={value ?? ""}
          type={kind === "email" ? "email" : "tel"}
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 w-72 max-w-full rounded-md border border-border bg-transparent px-2 py-1"
        />
      </label>
      <Button type="submit" className="min-h-11" disabled={busy}>
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

/**
 * A required attachment other than the CV: the owner ticks it to say they
 * will attach it in Gmail, which opens before anything can be attached.
 */
export function AttachTick({
  jobId,
  kit,
  id,
  name,
  ticked,
  disabled = false,
}: {
  jobId: string;
  kit: string;
  id: string;
  name: string;
  ticked: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(await decide(jobId, kit, { kind: "attach", id, ticked: next }));
    setBusy(false);
    router.refresh();
  }

  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-5"
        checked={ticked}
        disabled={busy || disabled}
        onChange={(event) => void toggle(event.currentTarget.checked)}
      />
      I will attach {name || "the file the post asks for"} in Gmail
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}
