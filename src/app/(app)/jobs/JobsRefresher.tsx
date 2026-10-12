"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { browserPage, refreshList } from "./polling";

/**
 * Keeps the running jobs the list shows moving, and the list current
 * (platform spec B9): it asks the server to advance each one, which claims
 * a job no invocation holds, then renders the list again. Opening the list
 * does so at once (review spec, "Jobs list"); polling.ts says when after
 * that. The list mounts it only while some job runs.
 */
export function JobsRefresher({ running }: { running: readonly string[] }) {
  const router = useRouter();
  const ids = running.join(",");

  useEffect(
    () =>
      refreshList(
        () =>
          Promise.all(
            ids
              .split(",")
              .filter(Boolean)
              .map((id) =>
                fetch(`/api/jobs/${id}/advance`, { method: "POST" }).catch(() => undefined),
              ),
          ),
        () => router.refresh(),
        browserPage(),
      ),
    [ids, router],
  );

  return null;
}
