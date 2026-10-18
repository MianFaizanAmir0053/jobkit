"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";

import { gateChanged, holdOutbound } from "../polling";

import { messageFor } from "./ActionButton";

/**
 * Posts one of the owner's decisions on the kit the page shows; the page is
 * then drawn again with the gate it leaves, but only once the server
 * answered: drawing it again on a dropped connection, Next reloads it whole
 * and loses what the owner typed. A page drawn on another kit is refused,
 * and drawn again. While it is in flight the outbound controls wait, and
 * the job's pages in other tabs are told once it lands.
 */
async function decide(
  jobId: string,
  kit: string,
  action: object,
): Promise<{ error: string | null; answered: boolean }> {
  const release = holdOutbound();
  try {
    const response = await fetch(`/api/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, kit }),
    });
    return { error: response.ok ? null : messageFor(response.status), answered: true };
  } catch {
    return { error: "The connection dropped. Try again.", answered: false };
  } finally {
    release();
    gateChanged(jobId);
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
    const { error, answered } = await decide(jobId, kit, { kind: "retype", value: typed });
    setError(error);
    setBusy(false);
    if (answered) router.refresh();
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
 * "I meet this requirement", on a requirement only the owner can confirm
 * they meet (review spec, "Job page", item 4): it clears that row's flag,
 * named by its place among the kit's flags, as "I checked this" did.
 */
export function FitTick({
  jobId,
  kit,
  flag,
  ticked,
  disabled = false,
}: {
  jobId: string;
  kit: string;
  flag: string;
  ticked: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    const { error, answered } = await decide(jobId, kit, {
      kind: next ? "check_flag" : "uncheck_flag",
      flag,
    });
    setError(error);
    setBusy(false);
    if (answered) router.refresh();
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
      I meet this requirement
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}

/**
 * A required attachment other than the CV: the owner ticks it to say they
 * will attach it where they send the kit, in Gmail, which opens before
 * anything can be attached, or where they apply.
 */
export function AttachTick({
  jobId,
  kit,
  id,
  name,
  ticked,
  where,
  disabled = false,
}: {
  jobId: string;
  kit: string;
  id: string;
  name: string;
  ticked: boolean;
  /** Where the owner attaches it: "in Gmail", or "where you apply". */
  where: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    const { error, answered } = await decide(jobId, kit, { kind: "attach", id, ticked: next });
    setError(error);
    setBusy(false);
    if (answered) router.refresh();
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
      I will attach {name || "the file the post asks for"} {where}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}
