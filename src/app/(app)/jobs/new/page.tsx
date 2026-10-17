import type { Metadata } from "next";

import { isUuid } from "@/lib/uuid";
import { newJobsAllowedForViewer, requireSession } from "@/server/dal";

import { NewJobForm } from "./NewJobForm";

export const metadata: Metadata = { title: "New job · jobkit" };

/** Why the share target's worker refused a share (public/sw.js), in the page's words. */
const REFUSED: Readonly<Record<string, string>> = {
  empty: "Nothing arrived from the share. Use Choose screenshots instead.",
  link: "LinkedIn's share sends only a link, which jobkit never opens. Take screenshots of the post and share those.",
  off: "Sharing to jobkit is off for now. Use Choose screenshots instead.",
  unkept: "This phone could not keep the shared screenshots. Use Choose screenshots instead.",
};

/**
 * The New job page (intake spec, "Inputs"): paired phones use it as much as
 * the laptop. A share the service worker kept opens it with its ID, and the
 * upload starts with no further tap; a share it refused opens it with why.
 * Once this month's spend reaches the cap, it starts no job (ledger spec).
 */
export default async function NewJobPage(props: PageProps<"/jobs/new">) {
  await requireSession();
  const { share, refused } = await props.searchParams;
  const allowed = await newJobsAllowedForViewer();

  return (
    <section aria-labelledby="new-job-heading">
      <h1 id="new-job-heading" className="text-2xl font-semibold tracking-tight">
        New job
      </h1>
      <p className="mt-2 text-muted-foreground">
        Screenshots of a job post, its text, or both. jobkit never opens a link in the post.
      </p>
      {allowed ? (
        <NewJobForm
          share={typeof share === "string" && isUuid(share) ? share : null}
          refused={typeof refused === "string" ? (REFUSED[refused] ?? null) : null}
        />
      ) : (
        <p role="alert" className="mt-6 text-sm text-destructive">
          This month&apos;s model spend has reached its cap for new jobs, so jobkit starts none
          until next month.
        </p>
      )}
    </section>
  );
}
