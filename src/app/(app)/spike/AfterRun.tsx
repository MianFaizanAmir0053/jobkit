"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Starts the 200-second background run that checks Vercel's function limit. */
export function AfterRun() {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const response = await fetch("/api/spike/after", { method: "POST" });
      setNotice(
        response.status === 202
          ? "Started. In Vercel's logs, look for the line saying it finished after about 200 seconds."
          : `It did not start (${response.status}).`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <Button disabled={busy} onClick={() => void start()}>
        Start a 200-second run
      </Button>
      {notice && (
        <p role="status" className="mt-2 text-sm">
          {notice}
        </p>
      )}
    </div>
  );
}
