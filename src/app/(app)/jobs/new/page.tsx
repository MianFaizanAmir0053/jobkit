import type { Metadata } from "next";

import { requireSession } from "@/server/dal";

import { NewJobForm } from "./NewJobForm";

export const metadata: Metadata = { title: "New job · jobkit" };

/** The New job page (intake spec, "Inputs"): paired phones use it as much as the laptop. */
export default async function NewJobPage() {
  await requireSession();

  return (
    <section aria-labelledby="new-job-heading">
      <h1 id="new-job-heading" className="text-2xl font-semibold tracking-tight">
        New job
      </h1>
      <p className="mt-2 text-muted-foreground">
        Screenshots of a job post, its text, or both. jobkit never opens a link in the post.
      </p>
      <NewJobForm />
    </section>
  );
}
