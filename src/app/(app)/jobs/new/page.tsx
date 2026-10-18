import type { Metadata } from "next";
import { headers } from "next/headers";

import Link from "next/link";

import {
  jobForViewer,
  newJobsAllowedForViewer,
  requireSession,
  viewerTimeZone,
} from "@/server/dal";
import { ownerSent } from "@/server/shareStart";

import { formatTime } from "../words";

import { NewJobForm } from "./NewJobForm";

export const metadata: Metadata = { title: "New job · jobkit" };

/** Why the share target's worker refused a share (public/sw.js), in the page's words. */
const REFUSED: Readonly<Record<string, string>> = {
  empty: "Nothing arrived from the share. Use Choose screenshots instead.",
  link: "LinkedIn's share sends only a link, which jobkit never opens. Take screenshots of the post and share those.",
  big: "This share is more than jobkit takes: at most 8 screenshots of 40 MB each and 20,000 characters of text. Share less, or use Choose screenshots.",
  off: "Sharing to jobkit is off for now. Use Choose screenshots instead.",
  unkept: "This phone could not keep the shared screenshots. Use Choose screenshots instead.",
};

/**
 * The New job page (intake spec, "Inputs"): paired phones use it as much as
 * the laptop. A share the service worker kept opens it with its ID, and the
 * upload starts with no further tap when the owner sent the request
 * (ownerSent), on the share's first opening; any other share waits for the
 * owner's tap on Start. A share the worker refused opens it with why. Once
 * this month's spend reaches the cap, it starts no job and drops a share,
 * yet still finishes an upload begun before (ledger spec). Opened from a
 * job whose upload failed (`?again=<id>`), it takes that job's screenshots
 * again (intake spec, "Upload path", step 5) while the job waits for them,
 * and while they upload, so a reload finishes the upload this browser
 * kept. The form is keyed by what it is for, so nothing of a New job form,
 * such as a share it held, carries over to an upload again, nor back.
 */
export default async function NewJobPage(props: PageProps<"/jobs/new">) {
  await requireSession();
  const { refused, again } = await props.searchParams;
  const allowed = await newJobsAllowedForViewer();
  const site = (await headers()).get("sec-fetch-site");
  if (typeof again === "string") {
    const job = await jobForViewer(again);
    const failed = job?.state === "upload_failed";
    // Uploading: a reload in the middle of an upload again finishes what this browser kept.
    const uploading = job?.state === "uploading";
    return (
      <section aria-labelledby="new-job-heading">
        <h1 id="new-job-heading" className="text-2xl font-semibold tracking-tight">
          Upload again
        </h1>
        {job && (
          // Which job: one whose upload failed has no reading of its post to name it by.
          <p className="mt-1 text-sm text-muted-foreground">
            The job started {formatTime(job.receivedAt, await viewerTimeZone())}.
          </p>
        )}
        {!job ? (
          <p className="mt-2">
            This job could not be found.{" "}
            <Link href="/jobs" className="underline">
              Open the Jobs list
            </Link>
            .
          </p>
        ) : failed || uploading ? (
          allowed && (
            <p className="mt-2 text-muted-foreground">
              {failed
                ? "Choose every screenshot of the post again: they replace all of this job's screenshots, and the job goes on once they all arrive."
                : "This job's screenshots are on their way. If this browser kept them, jobkit finishes the upload now. To start the upload over, choose every screenshot again and press Start: the upload under way stops."}
            </p>
          )
        ) : (
          <p className="mt-2">
            This job is not waiting for its screenshots.{" "}
            <Link href={`/jobs/${job.id}`} className="underline">
              Open the job
            </Link>{" "}
            to see how it stands.
          </p>
        )}
        {!allowed && (
          <p role="alert" className="mt-6 text-sm text-destructive">
            This month&apos;s model spend has reached its cap for new jobs, so jobkit starts none
            until next month.
          </p>
        )}
        {job && (failed || uploading) && (
          <NewJobForm
            key={`again-${job.id}`}
            refused={null}
            autoStart={false}
            capped={!allowed}
            again={job.id}
          />
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="new-job-heading">
      <h1 id="new-job-heading" className="text-2xl font-semibold tracking-tight">
        New job
      </h1>
      <p className="mt-2 text-muted-foreground">
        Screenshots of a job post, its text, or both. jobkit never opens a link in the post.
      </p>
      {!allowed && (
        <p role="alert" className="mt-6 text-sm text-destructive">
          This month&apos;s model spend has reached its cap for new jobs, so jobkit starts none
          until next month.
        </p>
      )}
      <NewJobForm
        key="new"
        refused={typeof refused === "string" ? (REFUSED[refused] ?? null) : null}
        autoStart={ownerSent(site)}
        capped={!allowed}
      />
    </section>
  );
}
