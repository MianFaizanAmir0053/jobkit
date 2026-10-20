import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { claimsForLabelling } from "../../../../../../evals/liveClaims";
import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { ARCHIVE, fromLaptop, labellingAllowed } from "@/server/labelling";

import { JudgeLabel } from "../judge/JudgeLabel";

export const metadata: Metadata = { title: "Live claims · jobkit" };

/**
 * The claims from live drafts (evals spec, "Labelling" and "Metrics"):
 * each claim the pull kept beside a live case, with the facts it cites, to
 * be called supported by them or not, once and blind: what the separate
 * check said of it never shows. Only on the laptop's dev server with
 * JOBKIT_LOCAL_EVALS=1; no build has it.
 */
export default async function LiveClaimsPage() {
  const container = await getContainer();
  const sent = await headers();
  const laptop = fromLaptop({
    host: sent.get("host"),
    forwardedFor: sent.get("x-forwarded-for"),
    forwarded: sent.get("forwarded"),
  });
  if (!labellingAllowed(process.env, container.kind) || !laptop) notFound();
  await requireSession({ kind: "google" });
  const claims = claimsForLabelling(ARCHIVE);
  const left = claims.filter((claim) => claim.label === null).length;

  return (
    <section aria-labelledby="claims-heading" className="flex flex-col gap-4">
      <h1 id="claims-heading" className="text-2xl font-semibold tracking-tight">
        Live claims
      </h1>
      {claims.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No claims yet: <code>npm run eval:pull</code> keeps the claims in the draft of each kept
          job beside its case.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Call each sentence supported only when the facts beside it say all of it: the years, the
          depth, the scale, the seniority, every skill. Each is labelled once. {left} of{" "}
          {claims.length} left.
        </p>
      )}
      <ol className="flex flex-col gap-4">
        {claims.map((claim) => (
          <li key={claim.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="font-medium">{claim.sentence}</p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {claim.facts.map((fact) => (
                <li key={fact.id}>
                  {fact.statement} ({fact.kind}; {fact.depth}
                  {fact.years === undefined ? "" : `; ${fact.years} years`}
                  {fact.skills.length > 0 ? `; ${fact.skills.join(", ")}` : ""})
                </li>
              ))}
            </ul>
            <JudgeLabel
              id={claim.id}
              label={claim.label}
              url={`/api/dev/label/claims/${claim.caseId}/${claim.blockId}`}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
