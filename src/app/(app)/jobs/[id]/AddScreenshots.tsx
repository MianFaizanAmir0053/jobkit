"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";

import { prepareImage, type PreparedImage } from "../new/prepare";

/**
 * "Add screenshots" on a job (intake spec, item 4): more of the post, which
 * jobkit reads again whole, or an application form's questions, which it
 * reads and answers alone. Each screenshot is prepared as on New job, sent
 * straight to storage with a signed URL, and then confirmed, which is when
 * it becomes the job's. The page showed the job as of `since`: an add made
 * after it moved on is refused, and says so. Reading the post again drafts a
 * ready kit afresh, so the owner confirms it first.
 */
export function AddScreenshots({
  jobId,
  since,
  form,
  kit,
}: {
  jobId: string;
  since: string;
  /** Whether the kit is a form's, which takes its questions' screenshots. */
  form: boolean;
  /** Whether the job has a ready kit, which more of the post replaces. */
  kit: boolean;
}) {
  const router = useRouter();
  const inputId = useId();
  const [purpose, setPurpose] = useState<"post" | "form">(form ? "form" : "post");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function add(files: readonly File[]) {
    if (files.length === 0) return;
    if (
      purpose === "post" &&
      kit &&
      !window.confirm(
        "jobkit reads the post again whole and drafts the kit afresh: your edits and choices on this kit go. Add them?",
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const prepared: PreparedImage[] = [];
      for (const file of files) {
        const ready = await prepareImage(file);
        if (!ready.ok) {
          setMessage(ready.message);
          return;
        }
        prepared.push(ready);
      }
      const images = prepared.map((each) => each.meta);
      const started = await post(`/api/jobs/${jobId}/add-images`, { purpose, since, images });
      if (!started.ok) {
        setMessage(started.message);
        return;
      }
      const uploads = (started.body as { uploads: { sha256: string; path: string; url: string }[] })
        .uploads;
      // The server leaves out screenshots the job has already: each upload names its own.
      const bySha = new Map(prepared.map((each) => [each.meta.sha256, each]));
      const sent: (PreparedImage["meta"] & { path: string })[] = [];
      for (const upload of uploads) {
        const image = bySha.get(upload.sha256);
        if (!image) continue;
        const meta = image.meta;
        if (!(await putOnce(upload.url, image.blob))) {
          setMessage("A screenshot did not upload. Check the connection and add them again.");
          return;
        }
        sent.push({ ...meta, path: upload.path });
      }
      const confirmed = await post(`/api/jobs/${jobId}/add-images/confirm`, {
        purpose,
        since,
        images: sent,
      });
      if (!confirmed.ok) {
        setMessage(confirmed.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {form
          ? "Add screenshots of the application form's questions, and jobkit answers the new ones, or more of the post, and jobkit reads it again."
          : "Add more of the post, and jobkit reads it again and drafts the kit afresh."}
      </p>
      {form && (
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">What the screenshots show</legend>
          {(
            [
              ["form", "The form's questions"],
              ["post", "More of the post"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`${inputId}-purpose`}
                value={value}
                checked={purpose === value}
                onChange={() => setPurpose(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <label htmlFor={inputId} className="sr-only">
          Screenshots to add
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          className="hidden"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void add(files);
          }}
        />
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => document.getElementById(inputId)?.click()}
        >
          {busy ? "Adding…" : "Add screenshots"}
        </Button>
      </div>
      {message && (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

/** Why an add was refused, in the page's words. */
function refusedWords(status: number, body: { error?: string; message?: string } | null): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case "moved-on":
      return "The job changed since this page was drawn. Look again, then add them.";
    case "gone":
      return "The kit went already, so jobkit adds nothing to it.";
    case "not-a-form":
      return "This kit is not a form's, so it takes more of the post alone.";
    case "missing":
      return "A screenshot did not arrive. Add them again.";
    default:
      return status >= 500
        ? "Something went wrong on the server. Try again."
        : "jobkit could not add them. Try again.";
  }
}

async function post(
  url: string,
  body: object,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    return response.ok
      ? { ok: true, body: answer }
      : { ok: false, message: refusedWords(response.status, answer) };
  } catch {
    return { ok: false, message: "The connection dropped. Try again." };
  }
}

/**
 * Sends one screenshot to its signed URL, trying again twice on a dropped
 * connection, a timeout or a server error, each try at most a minute; a
 * refusal is final, as a signed URL takes one upload.
 */
async function putOnce(url: string, blob: Blob): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        body: blob,
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // A dropped connection or a timeout: try again.
    }
  }
  return false;
}
