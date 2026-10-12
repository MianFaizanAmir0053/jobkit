"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Polls every 2 seconds for the first minute, then every 5 (platform spec B9). */
const FAST_MS = 2_000;
const SLOW_MS = 5_000;
const FAST_FOR_MS = 60_000;

/**
 * Keeps a running job moving and its page current (platform spec B9). Each
 * poll asks the server to advance the job, which claims it when no
 * invocation holds it, then renders the page again from the server. It
 * polls only while mounted, which the page does only while the job runs or
 * uploads, and never while the page is hidden; showing the page again polls
 * at once.
 */
export function JobPoller({ jobId }: { jobId: string }) {
  const router = useRouter();

  useEffect(() => {
    const since = performance.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (stopped) return;
      const delay = performance.now() - since < FAST_FOR_MS ? FAST_MS : SLOW_MS;
      timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        await fetch(`/api/jobs/${jobId}/advance`, { method: "POST" }).catch(() => undefined);
        if (stopped) return;
        router.refresh();
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.hidden || stopped) return;
      clearTimeout(timer);
      void tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [jobId, router]);

  return null;
}
