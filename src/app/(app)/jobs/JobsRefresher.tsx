"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Renders the jobs list again every 10 seconds while the page shows a
 * running job, and never while the page is hidden (platform spec B9). The
 * list mounts it only while some job runs.
 */
export function JobsRefresher() {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [router]);

  return null;
}
