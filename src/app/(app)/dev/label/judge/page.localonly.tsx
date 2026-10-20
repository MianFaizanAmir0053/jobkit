import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { forLabelling, readJudgeSet } from "../../../../../../evals/judgeSet";
import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { fromLaptop, JUDGE_SET, labellingAllowed } from "@/server/labelling";

import { JudgeLabel } from "./JudgeLabel";

export const metadata: Metadata = { title: "Judge set · jobkit" };

/**
 * The frozen judge set's labelling (evals spec, "Labelling"): each sentence
 * with the facts it cites, to be called supported by them or not, once and
 * blind: no verdict and nothing of what the sentence was meant to be shows.
 * Only on the laptop's dev server with JOBKIT_LOCAL_EVALS=1; no build has
 * it.
 */
export default async function JudgeSetPage() {
  const container = await getContainer();
  const sent = await headers();
  const laptop = fromLaptop({
    host: sent.get("host"),
    forwardedFor: sent.get("x-forwarded-for"),
    forwarded: sent.get("forwarded"),
  });
  if (!labellingAllowed(process.env, container.kind) || !laptop) notFound();
  await requireSession({ kind: "google" });
  const set = readJudgeSet(JUDGE_SET);
  const items = set ? forLabelling(set) : [];
  const left = items.filter((item) => item.label === null).length;

  return (
    <section aria-labelledby="judge-heading" className="flex flex-col gap-4">
      <h1 id="judge-heading" className="text-2xl font-semibold tracking-tight">
        Judge set
      </h1>
      {set === null ? (
        <p className="text-sm text-muted-foreground">
          No judge set yet: make it with <code>npm run eval:judge-set -- --from</code> and the
          candidates file.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Call each sentence supported only when the facts beside it say all of it: the years, the
          depth, the scale, the seniority, every skill. Each is labelled once. {left} of{" "}
          {items.length} left.
        </p>
      )}
      <ol className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="font-medium">
              {item.id}. {item.sentence}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {item.facts.map((fact) => (
                <li key={fact.id}>
                  {fact.statement} ({fact.kind}; {fact.depth}
                  {fact.years === undefined ? "" : `; ${fact.years} years`}
                  {fact.skills.length > 0 ? `; ${fact.skills.join(", ")}` : ""})
                </li>
              ))}
            </ul>
            <JudgeLabel id={item.id} label={item.label} />
          </li>
        ))}
      </ol>
    </section>
  );
}
