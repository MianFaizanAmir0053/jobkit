"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";

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
 * A sentence of the email with Edit beside it (review spec, "Job page"): Edit
 * opens a box with the sentence as it stands, which the owner puts in their
 * own words; Save keeps them, and the email then waits until the owner
 * confirms them. The box stays, its buttons held, until the page shows the
 * words saved; a refusal keeps it open with what the owner typed, so neither
 * a dropped connection nor a page drawn on another kit loses it.
 */
export function SentenceEdit({
  jobId,
  kit,
  blockId,
  text,
  maxLength,
}: {
  jobId: string;
  kit: string;
  blockId: string;
  /** The sentence as it stands: the owner's words, or drafting's. */
  text: string;
  /** The most characters a sentence holds. */
  maxLength: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page drawn again after a save: the box shows until it is.
  const [refreshing, startRefresh] = useTransition();
  const shown = open || refreshing;
  const held = busy || refreshing;
  const editButton = useRef<HTMLButtonElement>(null);
  // Focus goes back to Edit once the box closes, for keyboard and screen-reader users.
  const closing = useRef(false);

  useEffect(() => {
    if (shown || !closing.current) return;
    closing.current = false;
    editButton.current?.focus();
  }, [shown]);

  function close() {
    closing.current = true;
    setError(null);
    setOpen(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = words.trim();
    if (typed === text.trim()) {
      close();
      return;
    }
    setBusy(true);
    const { error, answered } = await decide(jobId, kit, { kind: "edit", blockId, text: typed });
    setBusy(false);
    if (error === null) close();
    else setError(error);
    if (answered) startRefresh(() => router.refresh());
  }

  if (!shown) {
    return (
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 py-2.5 whitespace-pre-wrap">{text}</p>
        <Button
          ref={editButton}
          type="button"
          variant="ghost"
          className="min-h-11 shrink-0 underline"
          aria-label={`Edit: ${text}`}
          onClick={() => {
            setWords(text);
            setError(null);
            setOpen(true);
          }}
        >
          Edit
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Your words for this sentence</span>
        <textarea
          autoFocus
          value={words}
          maxLength={maxLength}
          rows={3}
          readOnly={held}
          onChange={(event) => setWords(event.currentTarget.value)}
          className="min-h-24 w-full rounded-md border border-border bg-background p-2"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={held || words.trim() === ""}>
          {held ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={held}
          onClick={close}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
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
 * they meet (review spec, "Job page", item 4): their word, kept by the
 * requirement's ID apart from "I checked this", which clears the row's
 * flag as that does; Approve & send never gives it for them.
 */
export function FitTick({
  jobId,
  kit,
  requirementId,
  requirement,
  ticked,
  disabled = false,
}: {
  jobId: string;
  kit: string;
  requirementId: string;
  /** The requirement's words, which name the tick for a screen reader. */
  requirement: string;
  ticked: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    const { error, answered } = await decide(jobId, kit, {
      kind: "meets",
      requirementId,
      ticked: next,
    });
    setError(error);
    setBusy(false);
    if (answered) router.refresh();
  }

  return (
    <div className="text-sm">
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          className="size-5"
          checked={ticked}
          disabled={busy || disabled}
          onChange={(event) => void toggle(event.currentTarget.checked)}
        />
        I meet this requirement
        <span className="sr-only">: {requirement}</span>
      </label>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
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
    <div className="text-sm">
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          className="size-5"
          checked={ticked}
          disabled={busy || disabled}
          onChange={(event) => void toggle(event.currentTarget.checked)}
        />
        I will attach {name || "the file the post asks for"} {where}
      </label>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
