import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { POOL, poolCandidates, readCase } from "../../../../../../evals/cases";
import { styleExamplesOf } from "../../../../../../evals/import";
import { ROUTE_KINDS } from "@/core/extraction/record";
import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { ARCHIVE, labellingAllowed, PROFILE } from "@/server/labelling";

import { AdoptButton, DismissButton, LabelForm, type LabelValues } from "./LabelForm";

export const metadata: Metadata = { title: "Label a case · jobkit" };

// Nothing chosen: a blind label is the owner's choice, never a default left alone.
const EMPTY: LabelValues = {
  company: "",
  role: "",
  route: "",
  contact: "",
  eligibility: "",
  must: [],
  cropShowsContact: null,
};

const SPLIT_WORDS = {
  test: "A test case: label it from the post and the email alone.",
  dev: "A dev case.",
  none: "No split yet: label it from the post and the email alone. npm run eval:split gives it one once it has screenshots.",
};

const LEFT_OUT_WORDS = {
  style_example:
    "Left out: its application holds one of your style examples, so it is never scored.",
  after_jobkit:
    "Left out: it was sent once jobkit was drafting your email, so its words may be a model's. It is never scored.",
};

/** A day as the laptop's calendar has it: 2026-03-16. */
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

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
 * One case to label (evals spec, "Labelling"): the email that was sent, or
 * a kept job's pasted text, the post's screenshots, the pool's screenshots
 * taken in the three days before the email, and the labels. Only a dev
 * case shows anything a model made: its pre-labels, and the crop a kept
 * job's second read stored, with the crop question.
 */
// Typed by hand: next typegen leaves local-only pages out, as every build does.
export default async function CasePage(props: { params: Promise<{ caseId: string }> }) {
  const container = await getContainer();
  if (!labellingAllowed(process.env, container.kind)) notFound();
  await requireSession({ kind: "google" });
  const { caseId } = await props.params;
  const found = await readCase(ARCHIVE, caseId, {
    styleExamples: styleExamplesOf(PROFILE).examples,
  });
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
          {SPLIT_WORDS[found.split ?? "none"]}{" "}
          {found.date ? `Sent or kept on ${localDay(found.date)}.` : ""}
        </p>
        {found.leftOut && (
          <p className="mt-1 text-sm text-destructive">{LEFT_OUT_WORDS[found.leftOut]}</p>
        )}
        {found.sameAs.length > 0 && (
          <p className="mt-1 text-sm text-destructive">
            Maybe the same application as {found.sameAs.join(", ")}: a resend or a reply. If so, set
            the extra ones aside as not applications; until then they share one split.
          </p>
        )}
        {found.problem && <p className="mt-1 text-sm text-destructive">{found.problem}</p>}
        <div className="mt-2">
          <DismissButton caseId={found.id} />
        </div>
      </div>

      {found.email && (
        <Panel title="The email you sent">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">From</dt>
            <dd>{found.email.from}</dd>
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

      {found.pastedText !== null && (
        <Panel title="The text pasted with the job">
          <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
            {found.pastedText}
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
                    {new Date(entry.takenAt).toLocaleString("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
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

      {found.cropFile && found.split === "dev" && (
        <Panel title="The crop jobkit read the contact from">
          <Screenshot folder={found.id} file={found.cropFile} />
        </Panel>
      )}

      <Panel title="Labels">
        <LabelForm
          caseId={found.id}
          routes={ROUTE_KINDS}
          initial={initial}
          suggested={found.labels === null && found.prelabels !== null}
          hasCrop={found.cropFile !== null && found.split === "dev"}
        />
      </Panel>
    </section>
  );
}
