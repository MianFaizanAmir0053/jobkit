import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { emailBody } from "@/core/drafting/kit";
import { isStrictAddress } from "@/core/extraction/contacts";
import type { Role } from "@/core/extraction/record";
import { gmailComposeUrl } from "@/core/review/gmail";
import type { JobView, Step } from "@/core/review/jobView";
import { jobForViewer, requireSession, viewerTimeZone } from "@/server/dal";

import { formatTime, STATE_WORDS } from "../words";

import { ActionButton } from "./ActionButton";
import { CopyButton } from "./CopyButton";
import { JobPoller } from "./JobPoller";

export const metadata: Metadata = { title: "Job · jobkit" };

const ROUTE_WORDS: Readonly<Record<Role["route"]["kind"], string>> = {
  email: "by email",
  ats_form: "through an application form",
  easy_apply: "with LinkedIn Easy Apply",
  careers_page: "on the company's careers page",
  whatsapp: "on WhatsApp",
  linkedin_dm: "by a LinkedIn message",
  linkedin_comment: "by commenting on the post",
  other: "another way the post describes",
  unknown: "a way the post does not say",
};

const STEP_WORDS: Readonly<Record<Step["status"], string>> = {
  done: "Done",
  running: "Working…",
  failed: "Failed",
  waiting: "",
  not_checked: "Not checked yet",
};

/**
 * The job page (review spec, as far as the thin path goes): the steps as
 * they run, the owner's answers in waiting and stopped states, Retry and
 * Skip after a failure, and the email kit with copy buttons, the Gmail
 * handoff and Mark sent. It polls while the job runs or uploads.
 */
export default async function JobPage(props: PageProps<"/jobs/[id]">) {
  await requireSession();
  const { id } = await props.params;
  const view = await jobForViewer(id);
  if (!view) notFound();
  const timeZone = await viewerTimeZone();
  const record = view.extraction?.record ?? null;
  const heading = [view.role?.title, record?.company.name].filter(Boolean).join(" · ") || "Job";
  const polling = view.kind === "running" || view.kind === "client";

  return (
    <section aria-labelledby="job-heading" className="flex flex-col gap-6">
      {polling && <JobPoller jobId={view.id} />}
      <div>
        <Link href="/jobs" className="text-sm text-muted-foreground hover:underline">
          ← Jobs
        </Link>
        <h1 id="job-heading" className="mt-1 text-2xl font-semibold tracking-tight">
          {heading}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {STATE_WORDS[view.state]} · started {formatTime(view.receivedAt, timeZone)}
        </p>
      </div>

      <Steps steps={view.steps} />
      <StatePanel view={view} />
      {record && <PostPanel view={view} />}
      {view.state === "kit_ready" && view.draft && <KitPanel view={view} timeZone={timeZone} />}
    </section>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-1 text-sm" aria-label="Steps">
      {steps.map((step) => (
        <li key={step.stage} className="flex justify-between gap-4 border-b border-border py-1">
          <span>{step.label}</span>
          <span className={step.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
            {STEP_WORDS[step.status]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StatePanel({ view }: { view: JobView }) {
  const base = `/api/jobs/${view.id}`;
  const skip = (
    <ActionButton
      url={`${base}/skip`}
      label="Skip"
      variant="outline"
      confirmText="Skip this job? It closes for good."
    />
  );

  switch (view.state) {
    case "failed":
      return (
        <Panel title="This step failed">
          <p>{view.failure?.reason}</p>
          {view.failure?.detail && (
            <details className="text-sm text-muted-foreground">
              <summary>Details</summary>
              <pre className="mt-2 whitespace-pre-wrap">{view.failure.detail}</pre>
            </details>
          )}
          <div className="flex gap-2">
            <ActionButton url={`${base}/retry`} label="Retry" />
            {skip}
          </div>
        </Panel>
      );
    case "stopped":
      return (
        <Panel title="Stopped">
          <p>{stopWords(view)}</p>
          <div className="flex gap-2">
            {view.canReadAgain && (
              <ActionButton
                url={`${base}/read-again`}
                label={view.stopReason === "no_role" ? "Read it again" : "This is a job post"}
              />
            )}
            {skip}
          </div>
        </Panel>
      );
    case "needs_eligibility_decision":
      return (
        <Panel title="This role may not be open to you">
          <EligibilityReasons view={view} />
          <p className="text-sm text-muted-foreground">
            If you know better (the post may be wrong, or you may have a permit it does not know
            of), draft anyway. Otherwise skip it.
          </p>
          <div className="flex gap-2">
            <ActionButton url={`${base}/draft-anyway`} label="Draft anyway" />
            {skip}
          </div>
        </Panel>
      );
    case "upload_failed":
      return (
        <Panel title="The upload did not finish">
          <p>The screenshots did not all arrive within 15 minutes. Start a new job with them.</p>
          <div className="flex gap-2">{skip}</div>
        </Panel>
      );
    case "needs_role_pick":
      return (
        <Panel title="This post offers several roles. Which one are you applying for?">
          <ul className="flex flex-col gap-3">
            {(view.extraction?.record.roles ?? []).map((role) => (
              <li key={role.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <RoleSummary role={role} />
                <div>
                  <ActionButton
                    url={`${base}/role`}
                    body={{ roleId: role.id }}
                    label="Apply for this role"
                  />
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">{skip}</div>
        </Panel>
      );
    case "closed":
      return <p className="text-muted-foreground">This job is closed.</p>;
    default:
      return null;
  }
}

function stopWords(view: JobView): string {
  if (view.stopReason === "language") {
    return "This post is not in English. jobkit drafts only English posts, so the job stops here.";
  }
  if (view.stopReason === "not_a_job_post") {
    return view.canReadAgain
      ? "This does not look like a job post. If it is one, say so and it is read again."
      : "This still does not look like a job post.";
  }
  return view.canReadAgain
    ? "No role was found in this post. It can be read again once."
    : "No role was found in this post, even when it was read again.";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function RoleSummary({ role }: { role: Role }) {
  const where = [role.location.work_mode, ...role.location.places.map((place) => place.text)]
    .filter((part) => part !== "" && part !== "unspecified")
    .join(", ");
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{role.title || "A role with no title"}</span>
      {where && <span className="text-muted-foreground">{where}</span>}
      <span className="text-muted-foreground">
        Apply {ROUTE_WORDS[role.route.kind]}
        {role.route.address && `: ${role.route.address}`}
      </span>
    </div>
  );
}

/** What extract read that the owner should see before anything else: scam signs, flags, lines aimed at AI. */
function PostPanel({ view }: { view: JobView }) {
  const extraction = view.extraction!;
  const scam = [...extraction.record.scam_signals, ...extraction.backstop];
  // From every role, once each: the model may record a line about the whole post under one role.
  const aimedAtAi = [
    ...new Set(
      extraction.record.roles.flatMap((role) => [
        ...role.instructions.filter((line) => line.addressed_to_ai).map((line) => line.text),
        ...role.screening_questions.filter((line) => line.addressed_to_ai).map((line) => line.text),
      ]),
    ),
  ];
  if (scam.length === 0 && extraction.flags.length === 0 && aimedAtAi.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {scam.length > 0 && (
        <Panel title="Possible scam signs">
          <ul className="list-disc pl-5 text-sm">
            {scam.map((signal, i) => (
              <li key={i}>&ldquo;{signal.quote}&rdquo;</li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Never send an ID card, a passport copy, bank details or a fee to apply for a job.
          </p>
        </Panel>
      )}
      {aimedAtAi.length > 0 && (
        <Panel title="Lines aimed at AI tools">
          <p className="text-sm">jobkit did not follow these lines:</p>
          <ul className="list-disc pl-5 text-sm">
            {aimedAtAi.map((line, i) => (
              <li key={i}>&ldquo;{line}&rdquo;</li>
            ))}
          </ul>
        </Panel>
      )}
      {extraction.flags.length > 0 && (
        <Panel title="Check these against the post">
          <ul className="list-disc pl-5 text-sm">
            {extraction.flags.map((flag, i) => (
              <li key={i}>{flag.message}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function KitPanel({ view, timeZone }: { view: JobView; timeZone: string }) {
  const draft = view.draft!;
  const role = view.role!;
  const kit = draft.kit;
  const body = emailBody(kit);
  const address = role.route.kind === "email" ? role.route.address : "";
  const strict = address !== "" && isStrictAddress(address);
  const blockText = new Map(kit.blocks.map((block) => [block.id, block.text]));
  const requirementText = new Map(role.requirements.map((entry) => [entry.id, entry.text]));
  const instructions = role.instructions.filter((line) => !line.addressed_to_ai);

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Not checked yet">
        <p className="text-sm">
          This version does not yet read the contact address a second time or check every sentence
          separately. Read the whole email before you send it.
        </p>
      </Panel>

      {view.eligibility && view.eligibility.reasons.length > 0 && (
        <Panel
          title={
            view.draftedAnyway
              ? "You chose to draft for a role that may not be open to you"
              : "Check these about the role"
          }
        >
          <EligibilityReasons view={view} />
        </Panel>
      )}

      <Panel title="The email">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">To</dt>
          <dd>
            {strict ? (
              address
            ) : address ? (
              <span className="text-destructive">
                This address did not pass the strict check. Type it yourself from the post.
              </span>
            ) : (
              <span>
                The post asks you to apply {ROUTE_WORDS[role.route.kind]}
                {role.route.address && `: ${role.route.address}`}. Use the text below there.
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd>{kit.subject}</dd>
        </dl>
        <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{body}</div>
        <div className="flex flex-wrap gap-2">
          {strict && (
            <a
              href={gmailComposeUrl(address, kit.subject, body)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants()}
            >
              Open in Gmail
            </a>
          )}
          <CopyButton text={kit.subject} label="Copy subject" />
          <CopyButton text={body} label="Copy email" />
        </div>
        <p className="text-sm text-muted-foreground">
          Gmail adds your signature. Attach your CV in Gmail before you send.
        </p>
      </Panel>

      {draft.flags.length > 0 && (
        <Panel title="Check these before you send">
          <ul className="flex flex-col gap-2 text-sm">
            {draft.flags.map((flag, i) => {
              const about = blockText.get(flag.at) ?? requirementText.get(flag.at);
              return (
                <li key={i}>
                  {flag.message}
                  {about && <span className="text-muted-foreground"> — &ldquo;{about}&rdquo;</span>}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {(instructions.length > 0 || role.required_attachments.length > 0) && (
        <Panel title="What the post asks of applicants">
          <ul className="list-disc pl-5 text-sm">
            {instructions.map((line, i) => (
              <li key={`i${i}`}>{line.text}</li>
            ))}
            {role.required_attachments.map((attachment, i) => (
              <li key={`a${i}`}>Attach: {attachment.name}</li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="How you fit">
        <table className="text-sm">
          <tbody>
            {role.requirements.map((requirement) => {
              const row = draft.fit.find((entry) => entry.requirementId === requirement.id);
              return (
                <tr key={requirement.id} className="border-b border-border align-top">
                  <td className="py-1 pr-3">
                    {requirement.text}
                    {requirement.priority === "must" ? "" : " (nice to have)"}
                  </td>
                  <td className="py-1 pr-3 font-medium">{row?.verdict ?? "not weighed"}</td>
                  <td className="py-1 text-muted-foreground">{row?.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title="After you send it">
        {view.application?.status === "sent" && view.application.sentAt ? (
          <p className="text-sm">Marked sent on {formatTime(view.application.sentAt, timeZone)}.</p>
        ) : (
          <div>
            <ActionButton
              url={`/api/jobs/${view.id}/sent`}
              label="Mark sent"
              confirmText="Mark this application as sent? Do this once you have sent the email from Gmail."
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/** What the eligibility check found, each with the post's words. */
function EligibilityReasons({ view }: { view: JobView }) {
  const reasons = view.eligibility?.reasons ?? [];
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {reasons.map((reason, i) => (
        <li key={i}>
          {reason.message}
          {reason.quote && (
            <span className="text-muted-foreground"> — &ldquo;{reason.quote}&rdquo;</span>
          )}
        </li>
      ))}
    </ul>
  );
}
