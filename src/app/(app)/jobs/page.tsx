import type { Metadata } from "next";

import { listJobs, requireSession } from "@/server/dal";

export const metadata: Metadata = { title: "Jobs · jobkit" };

export default async function JobsPage() {
  await requireSession();
  const jobs = await listJobs();

  return (
    <section aria-labelledby="jobs-heading">
      <h1 id="jobs-heading" className="text-2xl font-semibold tracking-tight">
        Jobs
      </h1>
      {jobs.length === 0 ? (
        <p className="mt-4 text-muted-foreground">
          No jobs yet. Share a job post from your phone to start one.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {jobs.map((job) => (
            <li key={job.id} className="py-3">
              {job.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
