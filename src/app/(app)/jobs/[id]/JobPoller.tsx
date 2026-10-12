"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { advanceJob, browserPage, pollJob } from "../polling";

/**
 * Keeps a running job moving and its page current (platform spec B9): each
 * poll asks the server to advance the job, which claims it when no
 * invocation holds it, then renders the page again from the server. The
 * page mounts it only while the job runs or uploads; polling.ts says when
 * it polls.
 */
export function JobPoller({ jobId }: { jobId: string }) {
  const router = useRouter();

  useEffect(
    () =>
      pollJob(
        () => advanceJob(jobId),
        () => router.refresh(),
        browserPage(),
      ),
    [jobId, router],
  );

  return null;
}
