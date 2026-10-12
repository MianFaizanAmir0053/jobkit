"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps the running jobs the list shows moving, and the list current
 * (platform spec B9): every 10 seconds, while the page is visible, it asks
 * the server to advance each one, which claims a job no invocation holds,
 * then renders the list again. The list mounts it only while some job runs.
 */
export function JobsRefresher({ running }: { running: readonly string[] }) {
  const router = useRouter();
  const ids = running.join(",");

  useEffect(() => {
    let busy = false;
    const timer = setInterval(() => {
      if (document.hidden || busy) return;
      busy = true;
      void Promise.all(
        ids
          .split(",")
          .filter(Boolean)
          .map((id) => fetch(`/api/jobs/${id}/advance`, { method: "POST" }).catch(() => undefined)),
      ).finally(() => {
        busy = false;
        router.refresh();
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [ids, router]);

  return null;
}
