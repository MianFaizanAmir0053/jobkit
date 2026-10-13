import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { listCases } from "../../../../../evals/cases";
import { styleExamplesOf } from "../../../../../evals/import";
import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { ARCHIVE, fromLaptop, labellingAllowed, PROFILE } from "@/server/labelling";

export const metadata: Metadata = { title: "Labelling · jobkit" };

/**
 * The labelling page (evals spec, "Labelling"): every case in the archive,
 * the ten test cases first, which are labelled from scratch before any
 * suggestion is shown. Viewing it never gives a case a split: npm run
 * eval:split does, once the cases are ready. Only on the laptop's dev
 * server with JOBKIT_LOCAL_EVALS=1; no build has it.
 */
export default async function LabellingPage() {
  const container = await getContainer();
  const sent = await headers();
  const laptop = fromLaptop({
    host: sent.get("host"),
    forwardedFor: sent.get("x-forwarded-for"),
    forwarded: sent.get("forwarded"),
  });
  if (!labellingAllowed(process.env, container.kind) || !laptop) notFound();
  await requireSession({ kind: "google" });
  const { examples, problems } = styleExamplesOf(PROFILE);
  const { cases, stray } = await listCases(ARCHIVE, { styleExamples: examples });
  const test = cases.filter((entry) => entry.split === "test" && entry.leftOut === null);
  const testLeft = test.filter((entry) => !entry.labelled).length;
  const unsplit = cases.filter((entry) => entry.split === null && !entry.leftOut && !entry.held);
  const held = cases.filter((entry) => entry.held);

  return (
    <section aria-labelledby="labelling-heading" className="flex flex-col gap-4">
      <h1 id="labelling-heading" className="text-2xl font-semibold tracking-tight">
        Labelling
      </h1>
      {test.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Label the test cases first, from the post and the email alone: they never show
          suggestions, before or after their labels are saved. {testLeft} of {test.length} test
          cases left.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No split yet. Add each case&apos;s screenshots and set aside what is not an application on
          its page, then run <code>npm run eval:split</code> to choose the ten test cases.
        </p>
      )}
      {test.length > 0 && unsplit.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {unsplit.length} cases have no split yet. Once they have their screenshots, run{" "}
          <code>npm run eval:split</code> again.
        </p>
      )}
      {held.length > 0 && (
        <p className="text-sm text-destructive">
          {held.length} cases wait without a split: each is another email of an application in the
          full test set. Set the extra ones aside with &ldquo;Not an application&rdquo; on their
          pages; running <code>npm run eval:split</code> again does not help them.
        </p>
      )}
      {problems.length > 0 && (
        <p className="text-sm text-destructive">
          Some style examples cannot be read, so the cases they match are not left out:{" "}
          {problems.join("; ")}.
        </p>
      )}
      {stray.length > 0 && (
        <p className="text-sm text-destructive">
          Not read as cases: {stray.join(", ")}. Put downloaded .eml files in one folder and run{" "}
          <code>npm run eval:import -- --eml &lt;folder&gt;</code>, which names the case folders.
        </p>
      )}
      {cases.length === 0 ? (
        <p className="text-sm">
          No cases yet. Import your sent mail with <code>npm run eval:import</code>, or pull kept
          jobs with <code>npm run eval:pull</code>.
        </p>
      ) : (
        <table className="text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Split</th>
              <th className="py-1 pr-3 font-normal">Date</th>
              <th className="py-1 pr-3 font-normal">Case</th>
              <th className="py-1 pr-3 font-normal">Screenshots</th>
              <th className="py-1 font-normal">Labels</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((entry) => (
              <tr key={entry.id} className="border-b border-border align-top">
                <td className="py-1 pr-3">
                  {entry.leftOut ? "left out" : entry.held ? "held" : (entry.split ?? "none")}
                </td>
                <td className="py-1 pr-3">
                  {entry.date ? new Date(entry.date).toLocaleDateString("en-CA") : "undated"}
                </td>
                <td className="py-1 pr-3">
                  <Link href={`/dev/label/${entry.id}`} className="underline">
                    {entry.title}
                  </Link>
                  {entry.problem && <p className="text-destructive">{entry.problem}</p>}
                  {entry.sameAs.length > 0 && (
                    <p className="text-muted-foreground">
                      The same application as {entry.sameAs.join(", ")}?
                    </p>
                  )}
                </td>
                <td className="py-1 pr-3">{entry.screenshots}</td>
                <td className="py-1">{entry.labelled ? "Saved" : "Not yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
