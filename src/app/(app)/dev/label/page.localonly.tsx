import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { listCases } from "../../../../../evals/cases";
import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { ARCHIVE, labellingAllowed } from "@/server/labelling";

export const metadata: Metadata = { title: "Labelling · jobkit" };

/**
 * The labelling page (evals spec, "Labelling"): every case in the archive,
 * the ten test cases first, which are labelled from scratch before any
 * suggestion is shown. Only on the laptop's dev server with
 * JOBKIT_LOCAL_EVALS=1; no build has it.
 */
export default async function LabellingPage() {
  const container = await getContainer();
  if (!labellingAllowed(process.env, container.kind)) notFound();
  await requireSession({ kind: "google" });
  const cases = await listCases(ARCHIVE);
  const test = cases.filter((entry) => entry.split === "test");
  const testLeft = test.filter((entry) => !entry.labelled).length;

  return (
    <section aria-labelledby="labelling-heading" className="flex flex-col gap-4">
      <h1 id="labelling-heading" className="text-2xl font-semibold tracking-tight">
        Labelling
      </h1>
      <p className="text-sm text-muted-foreground">
        Label the test cases first, from the post and the email alone: they show no suggestions
        until their labels are saved. {testLeft} of {test.length} test cases left.
      </p>
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
                <td className="py-1 pr-3">{entry.split}</td>
                <td className="py-1 pr-3">{entry.date?.slice(0, 10) ?? "undated"}</td>
                <td className="py-1 pr-3">
                  <Link href={`/dev/label/${entry.id}`} className="underline">
                    {entry.title}
                  </Link>
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
