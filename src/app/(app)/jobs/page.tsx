import type { Metadata } from "next";
import Link from "next/link";

import { listJobs, requireSession, viewerTimeZone } from "@/server/dal";

import { JobsRefresher } from "./JobsRefresher";
import { formatTime, STATE_WORDS } from "./words";

export const metadata: Metadata = { title: "Jobs · jobkit" };

/** The jobs list, newest first; it refreshes every 10 seconds while a job runs (platform spec B9). */
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
            <li key={job.id}>
              <Link href={`/jobs/${job.id}`} className="flex flex-col gap-0.5 py-3 hover:bg-muted">
                <span className="font-medium">
                  {[job.title, job.company].filter(Boolean).join(" · ") || "A job post"}
                </span>
                <span className="text-sm text-muted-foreground">
                  {job.sent ? "Sent" : job.skipped ? "Skipped" : STATE_WORDS[job.state]} ·{" "}
                  {formatTime(job.receivedAt, timeZone)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
