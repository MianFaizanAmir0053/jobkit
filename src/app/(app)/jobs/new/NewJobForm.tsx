"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { withoutHidden } from "@/core/intake/hidden";
import { MAX_HELD_MS } from "@/core/intake/limits";
import { isUuid } from "@/lib/uuid";

import { OPENING, type Opened, type OpeningDeps, openPage } from "./opening";
import {
  dropShare,
  heldShare,
  holdShare,
  type Share,
  sweepShares,
  takeShare,
} from "./pendingUploads";
import { prepareImage } from "./prepare";
import { browserDeps, keepsUpload, MESSAGES, resumeUpload, submitJob } from "./submit";

/**
 * How long a held share's Start waits after the last tap anywhere on the
 * page: a page that lures the owner into tapping again and again cannot land
 * a tap on Start before the owner has stopped to look.
 */
const QUIET_MS = 2_000;

/**
 * How long a share waited, which the job's clock counts from its arrival,
 * kept under the server's day, past which it calls the page's clock wrong.
 */
const waited = (arrivedAt: number) =>
  Math.max(0, Math.min(Date.now() - arrivedAt, MAX_HELD_MS - 60_000));

/** The browser's pieces for what New job does as it opens. */
const pageDeps: OpeningDeps = {
  shareId: () => {
    const id = new URLSearchParams(window.location.search).get("share");
    return id !== null && isUuid(id) ? id : null;
  },
  dropShareId: () => window.history.replaceState(null, "", "/jobs/new"),
  navigation: () => {
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return entry?.type ?? "";
  },
  takeShare,
  holdShare,
  heldShare,
  sweepShares,
  finishKept: (onStatus) =>
    resumeUpload(browserDeps, onStatus).catch(() => ({
      ok: false as const,
      message: MESSAGES.notResumed,
    })),
  start: (share, onStatus) =>
    submitJob(
      browserDeps,
      {
        files: share.images,
        text: withoutHidden(share.text),
        inputKind: "share",
        sharedUrl: withoutHidden(share.url),
        startedAgo: waited(share.arrivedAt),
      },
      onStatus,
    ),
};

/** A form on screen, following the opening run. */
interface Follower {
  status: (status: string) => void;
  hold: (share: Share, how: { shown: boolean; stored: boolean }) => void;
}

/**
 * The page's opening run, kept outside the form: React runs an effect twice
 * in development, and the owner may leave New job and come back while it
 * runs. Every form on screen follows its steps and the share it holds, so
 * none offers Start while it runs; a share held for the tap stays in the
 * store too, for a visit after the run.
 */
const opening: {
  run: Promise<Opened> | null;
  status: string | null;
  held: { share: Share; how: { shown: boolean; stored: boolean } } | null;
  followers: Set<Follower>;
} = { run: null, status: null, held: null, followers: new Set() };

const openingUi = {
  status: (status: string) => {
    opening.status = status;
    for (const follower of opening.followers) follower.status(status);
  },
  hold: (share: Share, how: { shown: boolean; stored: boolean }) => {
    opening.held = { share, how };
    for (const follower of opening.followers) follower.hold(share, how);
  },
};

/** A share the form holds: its screenshots, which the file input does not show, and its link. */
interface Shared {
  id: string;
  images: boolean;
  url: string;
  arrivedAt: number;
  /** Whether the store holds it, so Start takes it from there and no other tab starts it. */
  stored: boolean;
  /** Whether it waits for the tap, shown in full, or is starting by itself. */
  shown: boolean;
}

/**
 * The New job page's form (intake spec, "Inputs"): screenshots of a post,
 * its pasted text, or both. Start hands them to submitJob, which prepares,
 * uploads and confirms them, then opens the job. As the page opens,
 * openPage takes a share the service worker kept, or finishes an upload a
 * reload or a dropped connection cut short. A share held for the tap shows
 * as it will be sent (each screenshot as prepared, on white, at full width;
 * its text and link without the characters that only hide text), and Start
 * opens for it once the page has had no tap for two seconds. Start sends it
 * as a share, counting from its arrival, until the owner clears it. An
 * outcome that keeps the upload for New job to finish leaves nothing in the
 * form to start again.
 */
export function NewJobForm({
  refused,
  autoStart,
  capped,
}: {
  /** Why the service worker refused a share, in the page's words. */
  refused: string | null;
  /** Whether the owner sent this page's request, so a share may start untapped. */
  autoStart: boolean;
  /** Whether this month's spend reached the cap for new jobs: the form starts none. */
  capped: boolean;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [shared, setShared] = useState<Shared | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(refused);
  const [busy, setBusy] = useState(false);
  // When a share was shown for the tap, the last tap since, and a clock that ticks meanwhile.
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const [lastTap, setLastTap] = useState(0);
  const [clock, setClock] = useState(0);
  const armed = heldAt === null || clock - Math.max(heldAt, lastTap) >= QUIET_MS;
  const armedNow = useRef(armed);

  useEffect(() => {
    armedNow.current = armed;
  }, [armed]);

  useEffect(() => {
    if (heldAt === null) return;
    // Once Start is open, a tap is the owner's: it must not close Start under their finger.
    const tap = () => {
      if (!armedNow.current) setLastTap(Date.now());
    };
    document.addEventListener("pointerdown", tap, true);
    const tick = setInterval(() => setClock(Date.now()), 250);
    return () => {
      document.removeEventListener("pointerdown", tap, true);
      clearInterval(tick);
    };
  }, [heldAt]);

  function clearForm() {
    setFiles([]);
    setText("");
    setShared(null);
    setHeldAt(null);
  }

  useEffect(() => {
    // Set when the page goes, so a run that ends later opens no job over another page.
    let left = false;
    const follower: Follower = {
      status: (words) => {
        setBusy(true);
        setStatus(words);
      },
      hold: (share, how) => {
        setFiles(share.images);
        setText(withoutHidden(share.text));
        setShared({
          id: share.id,
          images: share.images.length > 0,
          url: withoutHidden(share.url),
          arrivedAt: share.arrivedAt,
          ...how,
        });
        setHeldAt(how.shown ? Date.now() : null);
      },
    };
    opening.followers.add(follower);
    // A run going on since an earlier visit: this form follows it too.
    if (opening.held) follower.hold(opening.held.share, opening.held.how);
    if (opening.status !== null) follower.status(opening.status);
    const run = (opening.run ??= openPage(pageDeps, { autoStart, capped }, openingUi).finally(
      () => {
        opening.run = null;
        opening.status = null;
        opening.held = null;
      },
    ));
    void run
      .then((opened) => {
        if (left) return;
        setBusy(false);
        setStatus(null);
        if (opened.kind === "finished" || opened.kind === "started") {
          const { outcome } = opened;
          if (outcome.ok) {
            // Busy until the job page replaces this one.
            setBusy(true);
            setStatus("Opening the job…");
            router.push(`/jobs/${outcome.jobId}`);
            return;
          }
          setError(outcome.message);
          if (opened.kind !== "started") return;
          // New job finishes a kept upload; a share whose start failed otherwise waits for Start.
          if (keepsUpload(outcome)) {
            clearForm();
          } else {
            setShared((held) => held && { ...held, shown: true });
            setHeldAt(Date.now());
          }
        } else if (opened.kind === "held") {
          setStatus(
            opened.before?.ok ? `${OPENING.uploadedBefore} ${opened.reason}` : opened.reason,
          );
          if (opened.before && !opened.before.ok) setError(opened.before.message);
        } else if (opened.kind === "gone") {
          setError(OPENING.shareGone);
          if (opened.before) {
            setStatus(opened.before.ok ? OPENING.uploadedBefore : opened.before.message);
          }
        }
      })
      .catch(() => {
        if (left) return;
        setStatus(null);
        setError(MESSAGES.wentWrong);
        setBusy(false);
      });
    return () => {
      left = true;
      opening.followers.delete(follower);
    };
  }, [router, autoStart, capped]);

  async function start() {
    setBusy(true);
    setError(null);
    if (shared) {
      // Taken out of the store first, so the share starts one job, whichever tab taps Start.
      const taken = await takeShare(shared.id).catch(() => null);
      if (!taken && shared.stored) {
        clearForm();
        setStatus(null);
        setError(OPENING.takenElsewhere);
        setBusy(false);
        return;
      }
    }
    const submitted = await submitJob(
      browserDeps,
      {
        files,
        text,
        ...(shared && {
          inputKind: "share" as const,
          sharedUrl: shared.url,
          // The share reached jobkit when it arrived, whoever tapped Start since.
          startedAgo: waited(shared.arrivedAt),
        }),
      },
      setStatus,
    ).catch(() => ({ ok: false as const, message: MESSAGES.wentWrong }));
    if (submitted.ok) {
      // Busy until the job page replaces this one, so Start is not pressed twice.
      setStatus("Opening the job…");
      router.push(`/jobs/${submitted.jobId}`);
      return;
    }
    setStatus(null);
    setError(submitted.message);
    // New job finishes a kept upload, so the form holds nothing to start a second time.
    if (keepsUpload(submitted)) clearForm();
    setBusy(false);
  }

  function clearShare() {
    if (shared) void dropShare(shared.id).catch(() => undefined);
    clearForm();
    setStatus(null);
    setError(null);
  }

  if (capped) {
    // No job starts here; an upload begun before the cap still finishes.
    return (
      <div className="mt-6 flex flex-col gap-2">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {status}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  const shown = shared?.shown === true;
  return (
    <form
      className="mt-6 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      {shown && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <p className="font-medium">From the share, as Start will send it</p>
          {shared.images && (
            <ul className="flex flex-col gap-3">
              {files.map((image, i) => (
                <li key={i}>
                  <SharedScreenshot file={image} />
                </li>
              ))}
            </ul>
          )}
          {shared.url !== "" && (
            // Text, never a link: jobkit never opens a post's links.
            <p className="text-sm break-all text-muted-foreground">Link: {shared.url}</p>
          )}
          <div>
            <Button type="button" variant="outline" disabled={busy} onClick={clearShare}>
              Clear the share
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor="screenshots" className="font-medium">
          Choose screenshots
        </label>
        <input
          id="screenshots"
          type="file"
          accept="image/*"
          multiple
          // A share's screenshots go only with the share: it is cleared first.
          disabled={busy || shared !== null}
          onChange={(event) => setFiles([...(event.target.files ?? [])])}
          className="text-sm"
        />
        {shown && (
          <p className="text-sm text-muted-foreground">
            Clear the share to choose other screenshots.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="pasted" className="font-medium">
          Paste text
        </label>
        <textarea
          id="pasted"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          className="rounded-md border border-border bg-background p-2 text-sm"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={busy || !armed || (files.length === 0 && text.trim() === "")}
        >
          Start
        </Button>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {status}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * A shared screenshot as Start will send it: prepared as the upload prepares
 * it (its first frame, on white), at the form's full width, so the owner
 * reads what the model will. One the upload would refuse says why.
 */
function SharedScreenshot({ file }: { file: File }) {
  const image = useRef<HTMLImageElement>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    void prepareImage(file).then((prepared) => {
      if (gone) return;
      if (!prepared.ok) {
        setRefusal(prepared.message);
        return;
      }
      url = URL.createObjectURL(prepared.blob);
      if (image.current) image.current.src = url;
    });
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  if (refusal) {
    return (
      <p className="text-sm text-destructive">
        {file.name}: {refusal}
      </p>
    );
  }
  // next/image draws images the server can fetch, not one only this browser holds.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={image} alt={file.name} className="h-auto w-full rounded border border-border" />;
}
