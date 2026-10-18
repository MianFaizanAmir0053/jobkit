"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { gateChanged, holdOutbound } from "../polling";

import { messageFor } from "./ActionButton";
import { decided, forget, wordsAfter } from "./wordsChain";

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
  words: string,
  action: object,
): Promise<{ error: string | null; answered: boolean }> {
  const release = holdOutbound();
  // The words this page's own decisions left, so a second tap before it is drawn again counts.
  const named = wordsAfter(jobId, words);
  try {
    const response = await fetch(`/api/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, kit, words: named }),
    });
    if (response.ok) {
      const answer = (await response.json().catch(() => null)) as { words?: unknown } | null;
      if (typeof answer?.words === "string") decided(jobId, named, answer.words);
    } else {
      // Refused: the page is drawn again with the words the server has, which the next one names.
      forget(jobId);
    }
    return { error: response.ok ? null : messageFor(response.status), answered: true };
  } catch {
    return { error: "The connection dropped. Try again.", answered: false };
  } finally {
    release();
    gateChanged(jobId);
  }
}

/**
 * Forgets what this page's decisions left once it is drawn with new words
 * (wordsChain): what it shows is then the server's, and words that come
 * back later, as after an Undo on the other device, are its own again.
 */
export function WordsDrawn({ jobId, words }: { jobId: string; words: string }) {
  useEffect(() => {
    forget(jobId);
  }, [jobId, words]);
  return null;
}

/**
 * A sentence of the email with Edit beside it (review spec, "Job page"): Edit
 * opens a box with the sentence as it stands, which the owner puts in their
 * own words; Save keeps them, and the email then waits until the owner
 * confirms them. The box stays, its buttons held, until the page shows the
 * words saved; a refusal keeps it open with what the owner typed, so neither
 * a dropped connection nor a page drawn again, on another kit included,
 * loses it while the sentence is still in the email. One deleted elsewhere
 * takes its box with it.
 */
export function SentenceEdit({
  jobId,
  kit,
  words,
  blockId,
  text,
  maxLength,
  prompt,
  added = false,
  last = false,
}: {
  jobId: string;
  kit: string;
  /** The email's words as the page shows them (wordsKey), which each decision names. */
  words: string;
  blockId: string;
  /** The sentence as it stands: the owner's words, or drafting's. */
  text: string;
  /** The most characters a sentence holds. */
  maxLength: number;
  /**
   * What to write, for a line only the owner can write ("Needs your line"):
   * shown in place of the placeholder, whose box opens empty.
   */
  prompt?: string;
  /** Whether it is a sentence the owner added, which a deletion takes for good. */
  added?: boolean;
  /** Whether it is the email's last sentence, which the email keeps: no Delete. */
  last?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The box opens with the sentence, or empty for a line still to write.
  const start = prompt === undefined ? text : "";
  const [typed, setTyped] = useState(start);
  // The sentence as it read when the box opened: one changed since, as on the other device, is
  // never saved over.
  const [openedOn, setOpenedOn] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page drawn again after a save or a deletion: the box shows until it is.
  const [refreshing, startRefresh] = useTransition();
  const shown = open || refreshing;
  const changedElsewhere = open && !busy && !refreshing && openedOn !== text;
  const held = busy || refreshing || changedElsewhere;
  const editButton = useRef<HTMLButtonElement>(null);
  // What the box's buttons name, so two open boxes are told apart.
  const named = prompt ?? openedOn;

  // While the box is open, the handoffs wait: the page shows words not saved yet.
  useEffect(() => {
    if (!open) return;
    return holdOutbound();
  }, [open]);
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

  async function send(action: object) {
    setBusy(true);
    const { error, answered } = await decide(jobId, kit, words, action);
    setBusy(false);
    if (error === null) close();
    else setError(error);
    if (answered) startRefresh(() => router.refresh());
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = typed.trim();
    if (next === text.trim()) {
      close();
      return;
    }
    await send({ kind: "edit", blockId, text: next });
  }

  if (!shown) {
    return (
      <div className="flex items-start gap-2">
        {prompt === undefined ? (
          <p className="min-w-0 flex-1 py-2.5 whitespace-pre-wrap">{text}</p>
        ) : (
          // The placeholder as the email holds it, and what to write in its place.
          <div className="min-w-0 flex-1 py-2.5">
            <p className="whitespace-pre-wrap">{text}</p>
            <p className="font-medium italic">{prompt}</p>
          </div>
        )}
        <Button
          ref={editButton}
          type="button"
          variant="ghost"
          className="min-h-11 shrink-0 underline"
          aria-label={prompt === undefined ? `Edit: ${text}` : `Write it: ${prompt}`}
          onClick={() => {
            setTyped(start);
            setOpenedOn(text);
            setError(null);
            setOpen(true);
          }}
        >
          {prompt === undefined ? "Edit" : "Write it"}
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">{prompt ?? "Your words for this sentence"}</span>
        <textarea
          autoFocus
          value={typed}
          maxLength={maxLength}
          rows={3}
          readOnly={held}
          onChange={(event) => setTyped(event.currentTarget.value)}
          className="min-h-24 w-full rounded-md border border-border bg-background p-2"
        />
      </label>
      {changedElsewhere && (
        <p role="status" className="font-medium">
          This sentence changed since you opened it, as when another draft is shown or on your other
          device: it now reads &ldquo;{text}&rdquo;. Copy your words if you need them, then Cancel
          and edit it again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="min-h-11"
          disabled={held || typed.trim() === ""}
          aria-label={`Save your words for: ${named}`}
        >
          {busy || refreshing ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy || refreshing}
          aria-label={`Cancel editing: ${named}`}
          onClick={close}
        >
          Cancel
        </Button>
        {!last && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 text-destructive"
            disabled={held}
            aria-label={`Delete this sentence: ${named}`}
            onClick={() => {
              // A sentence the owner added is gone for good; a drafted one comes back with Undo delete.
              if (added && !window.confirm("Delete your sentence? It cannot be brought back."))
                return;
              void send({ kind: "delete", blockId });
            }}
          >
            Delete this sentence
          </Button>
        )}
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
 * "Your line about", on a sentence in the owner's own words (drafting spec,
 * "Owner edits"): the must-have it answers, as its gap line, which a
 * missing line then no longer holds the email for; or none. The choice is
 * made, then saved with Save, so a keyboard's arrows never save one on the
 * way to another.
 */
export function AnswersPick({
  jobId,
  kit,
  words,
  blockId,
  sentence,
  value,
  options,
}: {
  jobId: string;
  kit: string;
  /** The email's words as the page shows them (wordsKey), which each decision names. */
  words: string;
  blockId: string;
  /** The sentence's words, which name the choice for a screen reader. */
  sentence: string;
  /** The requirement the sentence answers now; "" for none. */
  value: string;
  /** The must-haves it may answer, each with its words. */
  options: { id: string; text: string }[];
}) {
  const router = useRouter();
  const [picked, setPicked] = useState(value);
  // The server's word as the page was last drawn with it: a new one replaces what was picked.
  const [drawn, setDrawn] = useState(value);
  if (value !== drawn) {
    setDrawn(value);
    setPicked(value);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    // The choice the page showed: one made since, on the other device, is not replaced unseen.
    const { error, answered } = await decide(jobId, kit, words, {
      kind: "answers",
      blockId,
      requirementId: picked,
      was: value,
    });
    setBusy(false);
    setError(error);
    if (answered) router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">
          Your line about<span className="sr-only">, for &ldquo;{sentence}&rdquo;</span>
        </span>
        <select
          value={picked}
          disabled={busy}
          onChange={(event) => setPicked(event.currentTarget.value)}
          className="min-h-11 w-full rounded-md border border-border bg-background px-2"
        >
          <option value="">No requirement</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.text}
            </option>
          ))}
        </select>
      </label>
      {picked !== value && (
        <div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * "Add a sentence", below the email (review spec, "Job page"): a box for a
 * sentence in the owner's own words, put after the sentence they choose
 * (before the sign-off by default) or first; it waits, as an edit does,
 * until they confirm it. The box stays until the page shows it, a refusal
 * keeps what they typed, and the handoffs wait while it is open.
 */
export function AddSentence({
  jobId,
  kit,
  words,
  sentences,
  defaultAfter,
  maxLength,
  full,
}: {
  jobId: string;
  kit: string;
  /** The email's words as the page shows them (wordsKey), which each decision names. */
  words: string;
  /** The email's sentences as they stand, in order: each one the new sentence may follow. */
  sentences: { id: string; text: string }[];
  /** The sentence it follows unless the owner chooses another: the last before the sign-off. */
  defaultAfter: string;
  /** The most characters a sentence holds. */
  maxLength: number;
  /** Whether the owner added as many sentences as one draft takes. */
  full: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [after, setAfter] = useState(defaultAfter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const shown = open || refreshing;
  const held = busy || refreshing;

  // While the box is open, the handoffs wait: the owner is still writing.
  useEffect(() => {
    if (!open) return;
    return holdOutbound();
  }, [open]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const { error, answered } = await decide(jobId, kit, words, {
      kind: "add",
      after,
      text: typed.trim(),
    });
    setBusy(false);
    if (error === null) {
      setTyped("");
      setOpen(false);
    }
    setError(error);
    if (answered) startRefresh(() => router.refresh());
  }

  if (full) {
    return (
      <p className="text-muted-foreground">
        You added the most sentences one draft takes: edit or delete one of yours to change it.
      </p>
    );
  }
  if (!shown) {
    return (
      <div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => {
            setAfter(defaultAfter);
            setError(null);
            setOpen(true);
          }}
        >
          Add a sentence
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Your sentence, in your own words</span>
        <textarea
          autoFocus
          value={typed}
          maxLength={maxLength}
          rows={3}
          readOnly={held}
          onChange={(event) => setTyped(event.currentTarget.value)}
          className="min-h-24 w-full rounded-md border border-border bg-background p-2"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Put it after</span>
        <select
          value={after}
          disabled={held}
          onChange={(event) => setAfter(event.currentTarget.value)}
          className="min-h-11 w-full rounded-md border border-border bg-background px-2"
        >
          <option value="">The greeting: first in the email</option>
          {sentences.map((sentence) => (
            <option key={sentence.id} value={sentence.id}>
              {sentence.text.length > 60 ? `${sentence.text.slice(0, 59)}…` : sentence.text}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={held || typed.trim() === ""}>
          {held ? "Saving…" : "Add it"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={held}
          onClick={() => {
            setError(null);
            setOpen(false);
          }}
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
  words,
  kind,
  value,
}: {
  jobId: string;
  kit: string;
  /** The email's words as the page shows them (wordsKey), which each decision names. */
  words: string;
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
    // What the page showed typed: one typed since, on the other device, is not replaced unseen.
    const { error, answered } = await decide(jobId, kit, words, {
      kind: "retype",
      value: typed,
      was: value ?? "",
    });
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
  words,
  requirementId,
  requirement,
  ticked,
  disabled = false,
}: {
  jobId: string;
  kit: string;
  /** The email's words as the page shows them (wordsKey), which each decision names. */
  words: string;
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
    const { error, answered } = await decide(jobId, kit, words, {
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
  words,
  id,
  name,
  ticked,
  where,
  disabled = false,
}: {
  jobId: string;
  kit: string;
  /** The email's words as the page shows them (wordsKey), which each decision names. */
  words: string;
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
    const { error, answered } = await decide(jobId, kit, words, {
      kind: "attach",
      id,
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
