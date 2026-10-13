import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { POOL, poolCandidates, readCase } from "../../../../../../evals/cases";
import { ROUTE_KINDS } from "@/core/extraction/record";
import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { ARCHIVE, labellingAllowed } from "@/server/labelling";

import { AdoptButton, LabelForm, type LabelValues } from "./LabelForm";

export const metadata: Metadata = { title: "Label a case · jobkit" };

const EMPTY: LabelValues = {
  company: "",
  role: "",
  route: "email",
  contact: "",
  eligibility: "eligible",
  must: [],
  cropShowsContact: null,
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Screenshot({ folder, file }: { folder: string; file: string }) {
  const src = `/api/dev/archive/${folder}/${encodeURIComponent(file)}`;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      <Image
        src={src}
        alt={file}
        width={180}
        height={400}
        unoptimized
        className="h-auto w-44 rounded border border-border"
      />
    </a>
  );
}

/**
 * One case to label (evals spec, "Labelling"): the email that was sent, the
 * post's screenshots, the pool's screenshots taken in the three days before
 * it, and the labels. A test case shows no pre-labels until its own labels
 * are saved.
 */
// Typed by hand: next typegen leaves local-only pages out, as every build does.
export default async function CasePage(props: { params: Promise<{ caseId: string }> }) {
  const container = await getContainer();
  if (!labellingAllowed(process.env, container.kind)) notFound();
  await requireSession({ kind: "google" });
  const { caseId } = await props.params;
  const found = await readCase(ARCHIVE, caseId);
  if (!found) notFound();
  const candidates =
    found.source === "mail"
      ? poolCandidates(ARCHIVE, found.date ? new Date(found.date) : null)
      : [];
  const initial = found.labels ?? found.prelabels ?? EMPTY;

  return (
    <section aria-labelledby="case-heading" className="flex flex-col gap-4">
      <Link href="/dev/label" className="text-sm text-muted-foreground hover:underline">
        ← All cases
      </Link>
      <div>
        <h1 id="case-heading" className="text-2xl font-semibold tracking-tight">
          {found.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {found.split === "test"
            ? "A test case: label it from the post and the email alone."
            : "A dev case."}{" "}
          {found.date ? `Sent or kept on ${found.date.slice(0, 10)}.` : ""}
        </p>
      </div>

      {found.email && (
        <Panel title="The email you sent">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">To</dt>
            <dd>{found.email.to}</dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd>{found.email.subject}</dd>
          </dl>
          <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
            {found.email.text}
          </div>
        </Panel>
      )}

      <Panel title="The post's screenshots">
        {found.screenshotFiles.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {found.screenshotFiles.map((file) => (
              <Screenshot key={file} folder={found.id} file={file} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            None yet: add them from the screenshots below, or copy them into the case&apos;s folder.
          </p>
        )}
      </Panel>

      {found.source === "mail" && (
        <Panel title="Screenshots taken in the three days before">
          {candidates.length > 0 ? (
            <div className="flex flex-wrap gap-4">
              {candidates.map((entry) => (
                <div key={entry.file} className="flex flex-col items-start gap-1">
                  <Screenshot folder={POOL} file={entry.file} />
                  <span className="text-xs text-muted-foreground">
                    {entry.takenAt.slice(0, 16).replace("T", " ")}
                  </span>
                  <AdoptButton caseId={found.id} file={entry.file} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              None. Copy the phone&apos;s screenshots into private/archive/{POOL}/ to see them here.
            </p>
          )}
        </Panel>
      )}

      <Panel title="Labels">
        <LabelForm
          caseId={found.id}
          routes={ROUTE_KINDS}
          initial={initial}
          suggested={found.labels === null && found.prelabels !== null}
        />
      </Panel>
    </section>
  );
}
