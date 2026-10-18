import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { listJobs, requireSession, viewerTimeZone } from "@/server/dal";

import { ActionButton } from "./[id]/ActionButton";
import { JobsRefresher } from "./JobsRefresher";
import { formatTime, oneLine, ROUTE_LABELS, STATE_WORDS } from "./words";

export const metadata: Metadata = { title: "Jobs · jobkit" };

/**
 * The jobs list, newest first (review spec, "Jobs list"): each job's company
 * and role, its route, and its state or status; a failed job's reason with
 * Retry and Skip, and a failed upload's Upload again and Skip. A failed job
 * whose kit's send may have gone, or that can go back to the templates'
 * drafts, is skipped from its page, which warns of the send or offers the
 * drafts first. Skip names the job's state and when it reached it, so a
 * list drawn before the job moved on and came back is refused, and its
 * words name the job. It refreshes every 10 seconds while a job runs
 * (platform spec B9).
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
          {jobs.map((job) => {
            const name =
              oneLine([job.title, job.company].filter(Boolean).join(" · ")) || "A job post";
            // The job as a confirmation and a label name it: a post never read has no title.
            const who = `${name}, ${formatTime(job.receivedAt, timeZone)}`;
            const skip = (
              <ActionButton
                url={`/api/jobs/${job.id}/skip`}
                label="Skip"
                variant="outline"
                ariaLabel={`Skip ${who}`}
                body={{
                  state: job.state,
                  since: job.stateChangedAt.toISOString(),
                  uncertain: null,
                }}
                confirmText={`Skip "${who}"? It closes for good.`}
              />
            );
            // Skipped from its page, which warns of the send or offers the drafts first.
            const fromPage = job.uncertain
              ? "A send of its email may have gone: open the job to check before you skip it."
              : job.backToDrafts
                ? "Your templates' drafts are still there: open the job to go back to them."
                : null;
            return (
              <li key={job.id} className="flex flex-col gap-2 py-3">
                <Link href={`/jobs/${job.id}`} className="flex flex-col gap-0.5 hover:bg-muted">
                  <span className="font-medium">{name}</span>
                  <span className="text-sm text-muted-foreground">
                    {job.bounced
                      ? "Bounced"
                      : job.submitted
                        ? "Submitted"
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
                      <ActionButton
                        url={`/api/jobs/${job.id}/retry`}
                        label="Retry"
                        ariaLabel={`Retry ${who}`}
                        // The page offers going back to the drafts, or a warning, first.
                        variant={fromPage === null ? "default" : "outline"}
                      />
                      {fromPage === null && skip}
                    </div>
                    {fromPage !== null && (
                      <div className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3">
                        <p>{fromPage}</p>
                        <div>
                          <Link
                            href={`/jobs/${job.id}`}
                            className={`${buttonVariants({ variant: "outline" })} min-h-11`}
                            aria-label={`Open ${who}`}
                          >
                            Open the job
                          </Link>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {job.state === "upload_failed" && (
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={`/jobs/new?again=${job.id}`}
                      className={`${buttonVariants()} min-h-11`}
                      aria-label={`Upload again: ${who}`}
                    >
                      Upload again
                    </Link>
                    {skip}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
