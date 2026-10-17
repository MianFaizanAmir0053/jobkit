"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { browserDeps, resumeUpload, type Submitted, submitJob } from "./submit";

const WENT_WRONG = "Something went wrong. Check the connection and press Start again.";

/** The run finishing a kept upload: one at a time, though React runs an effect twice in development. */
let finishing: Promise<Submitted | null> | null = null;

/**
 * The New job page's form (intake spec, "Inputs"): screenshots of a post,
 * its pasted text, or both. Start hands them to submitJob, which prepares,
 * uploads and confirms them, then opens the job. On opening, the page
 * finishes an upload a reload or a dropped connection cut short, with no
 * tap (intake spec, "Upload path", step 3).
 */
export function NewJobForm() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Set when the page goes, so a run that ends later opens no job over another page.
    let left = false;
    finishing ??= resumeUpload(browserDeps, (shown) => {
      setBusy(true);
      setStatus(shown);
    }).finally(() => {
      finishing = null;
    });
    void finishing
      .then((resumed) => {
        if (left || !resumed) return;
        if (resumed.ok) {
          setStatus("Opening the job…");
          router.push(`/jobs/${resumed.jobId}`);
          return;
        }
        setStatus(null);
        setError(resumed.message);
        setBusy(false);
      })
      .catch(() => {
        if (left) return;
        setStatus(null);
        setBusy(false);
      });
    return () => {
      left = true;
    };
  }, [router]);

  async function start() {
    setBusy(true);
    setError(null);
    const submitted = await submitJob(browserDeps, { files, text }, setStatus).catch(() => ({
      ok: false as const,
      message: WENT_WRONG,
    }));
    if (submitted.ok) {
      // Busy until the job page replaces this one, so Start is not pressed twice.
      setStatus("Opening the job…");
      router.push(`/jobs/${submitted.jobId}`);
      return;
    }
    setStatus(null);
    setError(submitted.message);
    setBusy(false);
  }

  return (
    <form
      className="mt-6 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="screenshots" className="font-medium">
          Choose screenshots
        </label>
        <input
          id="screenshots"
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          onChange={(event) => setFiles([...(event.target.files ?? [])])}
          className="text-sm"
        />
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
        <Button type="submit" disabled={busy || (files.length === 0 && text.trim() === "")}>
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
