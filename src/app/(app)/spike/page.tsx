import type { Metadata } from "next";

import { requireSession } from "@/server/dal";

import { AfterRun } from "./AfterRun";
import { GmailHandoffs } from "./GmailHandoffs";

export const metadata: Metadata = { title: "Spikes · jobkit" };

/**
 * Task 8's three spikes, run on the owner's phone and on Vercel; the results
 * go in docs/runbook/spikes.md. This page, its share report and the spike
 * route are removed once the results are recorded.
 */
export default async function SpikePage() {
  await requireSession();

  return (
    <section aria-labelledby="spike-heading" className="space-y-8">
      <div>
        <h1 id="spike-heading" className="text-2xl font-semibold tracking-tight">
          Spikes
        </h1>
        <p className="mt-2 text-muted-foreground">
          Three checks on the phone and on Vercel. Note each result for docs/runbook/spikes.md.
        </p>
      </div>

      <section aria-labelledby="share-heading">
        <h2 id="share-heading" className="font-medium">
          1. Share target
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Install jobkit from Chrome&apos;s menu (Install app). Then, in the gallery, select two
          screenshots, tap Share and choose jobkit. A page then says what arrived.
        </p>
      </section>

      <section aria-labelledby="gmail-heading">
        <h2 id="gmail-heading" className="font-medium">
          2. Gmail handoffs
        </h2>
        <GmailHandoffs />
      </section>

      <section aria-labelledby="after-heading">
        <h2 id="after-heading" className="font-medium">
          3. Background run
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The pipeline runs its stages after the response, within the function&apos;s 300-second
          limit. This starts a run that lasts 200 seconds and logs as it goes.
        </p>
        <AfterRun />
      </section>
    </section>
  );
}
