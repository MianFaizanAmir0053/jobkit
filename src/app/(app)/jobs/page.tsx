import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { listJobs, requireSession, viewerTimeZone } from "@/server/dal";

import { ActionButton } from "./[id]/ActionButton";
import { JobsRefresher } from "./JobsRefresher";
import { formatTime, ROUTE_LABELS, STATE_WORDS } from "./words";

export const metadata: Metadata = { title: "Jobs · jobkit" };

/**
 * The jobs list, newest first (review spec, "Jobs list"): each job's company
 * and role, its route, and its state or status; a failed job's reason with
 * Retry and Skip, and a failed upload's Upload again and Skip. A failed job
 * whose kit's send may have gone is skipped from its page, which warns of
 * the send. It refreshes every 10 seconds while a job runs (platform spec B9).
 */
export default async function JobsPage() {
  await requireSession();
  const jobs = await listJobs();
  const timeZone = await viewerTimeZone();
  const running = jobs.filter((job) => job.kind === "running").map((job) => job.id);

  return (
    <section aria-labelledby="jobs-heading">
      {running.length > 0 && <JobsRefresher running={running} />}
      <h1 id="jobs-heading" className="text-2xl font-semibold tracking-tight">
        Jobs
      </h1>
      {jobs.length === 0 ? (
        <p className="mt-4 text-muted-foreground">
          No jobs yet.{" "}
          <Link href="/jobs/new" className="underline">
            Start one
          </Link>{" "}
          with screenshots or the text of a job post.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-col gap-2 py-3">
              <Link href={`/jobs/${job.id}`} className="flex flex-col gap-0.5 hover:bg-muted">
                <span className="font-medium">
                  {[job.title, job.company].filter(Boolean).join(" · ") || "A job post"}
                </span>
                <span className="text-sm text-muted-foreground">
                  {job.bounced
                    ? "Bounced"
                    : job.sent
                      ? "Sent"
                      : job.skipped
                        ? "Skipped"
                        : STATE_WORDS[job.state]}{" "}
                  {job.route && `· ${ROUTE_LABELS[job.route]} `}·{" "}
                  {formatTime(job.receivedAt, timeZone)}
                </span>
              </Link>
              {job.state === "failed" && (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="[overflow-wrap:anywhere]">{job.failure}</p>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton url={`/api/jobs/${job.id}/retry`} label="Retry" />
                    {job.uncertain ? (
                      <p className="text-muted-foreground">
                        A send of its email may have gone: open the job to check before you skip it.
                      </p>
                    ) : (
                      <ActionButton
                        url={`/api/jobs/${job.id}/skip`}
                        label="Skip"
                        variant="outline"
                        body={{ state: job.state, uncertain: null }}
                        confirmText="Skip this job? It closes for good."
                      />
                    )}
                  </div>
                </div>
              )}
              {job.state === "upload_failed" && (
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/jobs/new?again=${job.id}`}
                    className={`${buttonVariants()} min-h-11`}
                  >
                    Upload again
                  </Link>
                  <ActionButton
                    url={`/api/jobs/${job.id}/skip`}
                    label="Skip"
                    variant="outline"
                    body={{ state: job.state, uncertain: null }}
                    confirmText="Skip this job? It closes for good."
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
