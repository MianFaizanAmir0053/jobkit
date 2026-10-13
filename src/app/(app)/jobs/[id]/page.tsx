import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { type BlockVerdict, isBlocking } from "@/core/drafting/judge";
import { emailBody } from "@/core/drafting/kit";
import type { AgreementProblem } from "@/core/extraction/addressRead";
import { isStrictAddress } from "@/core/extraction/contacts";
import type { Role } from "@/core/extraction/record";
import { flagKey, NO_DECISIONS } from "@/core/review/decisions";
import { gmailComposeUrl } from "@/core/review/gmail";
import type { JobView, Step } from "@/core/review/jobView";
import { appConfig } from "@/server/config";
import { jobForViewer, requireSession, viewerTimeZone } from "@/server/dal";

import { duplicateLine, formatTime, placeOfFlag, STATE_WORDS } from "../words";

import { ActionButton } from "./ActionButton";
import { CopyButton } from "./CopyButton";
import { JobPoller } from "./JobPoller";
import { MarkSent } from "./MarkSent";
import { AttachTick, RetypeField } from "./Review";

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
  // The Google account jobkit signs in with: Gmail opens in it, and the page says to check its From.
  const account = appConfig().ownerEmail;
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
          {view.application?.status === "sent" ? "Sent" : STATE_WORDS[view.state]} · started{" "}
          {formatTime(view.receivedAt, timeZone)}
        </p>
      </div>

      <Steps steps={view.steps} />
      <StatePanel view={view} />
      {/* Banners, most serious first: the scam warning, then earlier applications. */}
      {record && <ScamPanel view={view} />}
      {view.state === "kit_ready" && <DuplicatePanel view={view} timeZone={timeZone} />}
      {record && <PostPanel view={view} />}
      {view.state === "kit_ready" && view.draft && (
        <KitPanel view={view} account={account} timeZone={timeZone} />
      )}
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

/** The post's scam signs, quoted, with "Continue anyway" while the kit is open to decisions. */
function ScamPanel({ view }: { view: JobView }) {
  const extraction = view.extraction!;
  const scam = [...extraction.record.scam_signals, ...extraction.backstop];
  if (scam.length === 0) return null;
  return (
    <Panel title="Possible scam signs">
      <ul className="list-disc pl-5 text-sm">
        {scam.map((signal, i) => (
          <li key={i}>&ldquo;{signal.quote}&rdquo;</li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Never send an ID card, a passport copy, bank details or a fee to apply for a job.
      </p>
      {view.review &&
        (view.review.decisions.continueAnyway ? (
          <p className="text-sm">You chose to continue anyway.</p>
        ) : (
          !view.kitParts?.sent && (
            <ActionButton
              url={`/api/jobs/${view.id}/review`}
              label="Continue anyway"
              variant="destructive"
              confirmText="This post shows signs of a scam. Continue with it anyway?"
              body={{ action: { kind: "continue_anyway" } }}
            />
          )
        ))}
    </Panel>
  );
}

/** Earlier applications the ledger matched, with "Apply again", until the kit is sent. */
function DuplicatePanel({ view, timeZone }: { view: JobView; timeZone: string }) {
  const repeats = view.duplicates.filter((match) => !match.covered);
  if (repeats.length === 0 || view.kitParts?.sent) return null;
  return (
    <Panel title="You may have applied before">
      <ul className="list-disc pl-5 text-sm">
        {repeats.map((match) => {
          const line = duplicateLine(match, timeZone);
          return (
            <li key={match.key}>
              {line.what}
              <span className="text-muted-foreground"> ({line.when})</span>
            </li>
          );
        })}
      </ul>
      <ActionButton
        url={`/api/jobs/${view.id}/apply-again`}
        label="Apply again"
        variant="outline"
        body={{ keys: repeats.map((match) => match.key) }}
      />
    </Panel>
  );
}

/** What extract read that the owner should see before the kit: lines aimed at AI, and its flags. */
function PostPanel({ view }: { view: JobView }) {
  const extraction = view.extraction!;
  // From every role, once each: the model may record a line about the whole post under one role.
  const lines = extraction.record.roles.flatMap((role) => [
    ...role.instructions.filter((line) => line.addressed_to_ai).map((line) => line.text),
    ...role.screening_questions.filter((line) => line.addressed_to_ai).map((line) => line.text),
  ]);
  const key = (line: string) => line.trim().toLowerCase().replace(/\s+/g, " ");
  const aimedAtAi = lines.filter(
    (line, i) => lines.findIndex((other) => key(other) === key(line)) === i,
  );
  if (extraction.flags.length === 0 && aimedAtAi.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
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
            {extraction.flags.map((flag, i) => {
              const place = placeOfFlag(flag.path);
              return (
                <li key={i}>
                  {place && <span className="font-medium">{place}: </span>}
                  {flag.message}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function KitPanel({
  view,
  account,
  timeZone,
}: {
  view: JobView;
  account: string;
  timeZone: string;
}) {
  const draft = view.draft!;
  const role = view.role!;
  const kit = draft.kit;
  const body = emailBody(kit);
  const byEmail = role.route.kind === "email";
  const address = byEmail ? role.route.address.trim() : "";
  const strict = address !== "" && isStrictAddress(address);
  const blockText = new Map(kit.blocks.map((block) => [block.id, block.text]));
  // The separate check's findings: overstated, unsupported, or saying more about the company.
  const judged = (view.judge?.verdicts ?? []).filter(isBlocking);
  const requirementText = new Map(role.requirements.map((entry) => [entry.id, entry.text]));
  const instructions = role.instructions.filter((line) => !line.addressed_to_ai);
  const unchecked = view.steps
    .filter((step) => step.status === "not_checked")
    .map((step) => step.label.toLowerCase());
  // The second read and the address checks: either one blocking keeps the address out of Gmail.
  const noun = role.route.kind === "whatsapp" ? "number" : "address";
  const disputed =
    view.contact && !view.contact.agreement.ok
      ? contactWords(view.contact.agreement.reason, noun)
      : null;
  // The To line already says when the address fails the strict check.
  const blocking = (view.addressChecks ?? []).filter((check) => check.blocking);
  const blockingShown = blocking.filter((check) => check.kind !== "syntax");
  const warnings = (view.addressChecks ?? []).filter((check) => !check.blocking);
  const unread =
    view.contact === null &&
    (role.route.kind === "email" || role.route.kind === "whatsapp") &&
    role.route.address.trim() !== "";
  // The outbound gate: every outbound control opens only when no reason holds it back.
  const decisions = view.review?.decisions ?? NO_DECISIONS;
  const gate = view.review?.gate ?? [];
  const open = view.review !== null && gate.length === 0;
  const sent = view.kitParts?.sent ?? false;
  const needsRetype = view.kitParts?.contact?.needsRetype ?? false;
  // Where the kit goes: the post's contact, or the one typed in its place once it passes.
  const to = view.handoff?.to ?? "";
  const typedChecks = needsRetype && to !== "" ? (decisions.retyped?.checks ?? []) : [];
  const checked = new Set(decisions.checked);
  const flagsChecked = new Set(decisions.flagsChecked);
  const reviewUrl = `/api/jobs/${view.id}/review`;
  const goes = role.route.kind === "whatsapp" ? "the message goes to" : "the email goes to";
  const cv = role.required_attachments.filter((attachment) => attachment.is_cv);

  return (
    <div className="flex flex-col gap-4">
      {(unread || unchecked.length > 0) && (
        <Panel title="Not checked yet">
          {unread && (
            <p className="text-sm">
              This job ran before jobkit read the {noun} a second time, so type it yourself from the
              post below.
            </p>
          )}
          {unchecked.length > 0 && (
            <p className="mt-2 text-sm">
              This job ran before these checks were built: {unchecked.join("; ")}. To have them run,
              send the post again as a new job.
            </p>
          )}
        </Panel>
      )}

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
            {byEmail && !needsRetype ? (
              address
            ) : byEmail && address ? (
              // The post's address, never shown as where the email goes while it must be typed.
              <span className="text-muted-foreground">
                The post gives {address}
                {strict ? "" : ", which did not pass the strict check"}.
              </span>
            ) : byEmail ? (
              <span className="text-destructive">
                The post asks you to apply by email, but jobkit found no address in it. Find it in
                the post.
              </span>
            ) : (
              <span>
                The post asks you to apply {ROUTE_WORDS[role.route.kind]}
                {role.route.address &&
                  (needsRetype ? `, and gives ${role.route.address}` : `: ${role.route.address}`)}
                . Use the text below there.
              </span>
            )}
            {disputed && <p className="mt-1 text-destructive">{disputed}</p>}
            {blockingShown.map((check) => (
              <p key={check.kind} className="mt-1 text-destructive">
                {check.message}
              </p>
            ))}
            {!needsRetype &&
              warnings.map((check) => (
                <p key={check.kind} className="mt-1 text-muted-foreground">
                  {check.message}
                </p>
              ))}
            {needsRetype && view.kitParts?.contact && !sent && (
              <RetypeField
                jobId={view.id}
                kind={view.kitParts.contact.kind}
                value={decisions.retyped?.value ?? null}
              />
            )}
            {needsRetype && to !== "" && (
              <p className="mt-1">
                You typed it: {goes} <span className="font-medium">{to}</span>.
              </p>
            )}
            {typedChecks.map((check) => (
              <p
                key={`typed-${check.kind}`}
                className={`mt-1 ${check.blocking ? "text-destructive" : "text-muted-foreground"}`}
              >
                {check.message}
              </p>
            ))}
            {view.contact?.agreement.ok && blocking.length === 0 && (!byEmail || strict) && (
              <p className="mt-1 text-muted-foreground">Read a second time: it matches.</p>
            )}
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd>{kit.subject}</dd>
        </dl>
        <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{body}</div>
        {!open && (
          <div className="rounded-md border border-destructive/40 p-3 text-sm">
            <p className="font-medium">{sent ? "Sent already" : "Before you send"}</p>
            <ul className="mt-1 list-disc pl-5">
              {gate.map((reason, i) => {
                // A sentence's finding names the sentence, so two findings never read alike.
                const about =
                  reason.kind === "judge"
                    ? blockText.get(reason.blockId)
                    : reason.kind === "flag"
                      ? (blockText.get(reason.flag.at) ?? requirementText.get(reason.flag.at))
                      : undefined;
                return (
                  <li key={i}>
                    {reason.message}
                    {about && (
                      <span className="text-muted-foreground"> — &ldquo;{about}&rdquo;</span>
                    )}
                  </li>
                );
              })}
              {view.review === null && <li>This kit cannot be checked. Send the post again.</li>}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {byEmail &&
            (open ? (
              <a
                href={gmailComposeUrl(to, kit.subject, body, account || null)}
                target="_blank"
                rel="noopener noreferrer"
                className={`${buttonVariants()} min-h-11`}
              >
                Open in Gmail
              </a>
            ) : (
              <span
                role="link"
                aria-disabled="true"
                className={`${buttonVariants()} pointer-events-none min-h-11 opacity-50`}
              >
                Open in Gmail
              </span>
            ))}
          <CopyButton text={kit.subject} label="Copy subject" disabled={!open} />
          <CopyButton text={body} label="Copy email" disabled={!open} />
        </div>
        <p className="text-sm text-muted-foreground">
          In Gmail, {account ? `check that From shows ${account}, ` : "check the From address, "}
          attach your CV, and send. Gmail adds your signature. If you change the email&apos;s
          wording in Gmail, answer Yes when jobkit asks; attaching your CV does not count.
        </p>
      </Panel>

      {(draft.flags.length > 0 || judged.length > 0) && (
        <Panel title="Check these before you send">
          <ul className="flex flex-col gap-2 text-sm">
            {judged.map((verdict) => (
              <li key={`judge-${verdict.blockId}`}>
                {judgeWords(verdict)}
                <span className="text-muted-foreground">
                  {" "}
                  — &ldquo;{blockText.get(verdict.blockId)}&rdquo;
                </span>
                {!sent && (
                  <div className="mt-1 flex items-center gap-2">
                    {checked.has(verdict.blockId) ? (
                      <>
                        <span className="text-muted-foreground">You checked this.</span>
                        <ActionButton
                          url={reviewUrl}
                          label="Undo"
                          variant="outline"
                          body={{ action: { kind: "uncheck", blockId: verdict.blockId } }}
                        />
                      </>
                    ) : (
                      <ActionButton
                        url={reviewUrl}
                        label="I checked this"
                        variant="outline"
                        body={{ action: { kind: "check", blockId: verdict.blockId } }}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
            {draft.flags.map((flag) => {
              const key = flagKey(flag);
              const about = blockText.get(flag.at) ?? requirementText.get(flag.at);
              return (
                <li key={key}>
                  {flag.message}
                  {about && <span className="text-muted-foreground"> — &ldquo;{about}&rdquo;</span>}
                  {!sent && (
                    <div className="mt-1 flex items-center gap-2">
                      {flagsChecked.has(key) ? (
                        <>
                          <span className="text-muted-foreground">You checked this.</span>
                          <ActionButton
                            url={reviewUrl}
                            label="Undo"
                            variant="outline"
                            body={{ action: { kind: "uncheck_flag", flag: key } }}
                          />
                        </>
                      ) : (
                        <ActionButton
                          url={reviewUrl}
                          label="I checked this"
                          variant="outline"
                          body={{ action: { kind: "check_flag", flag: key } }}
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {(instructions.length > 0 || role.required_attachments.length > 0) && (
        <Panel title="What the post asks of applicants">
          {instructions.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {instructions.map((line, i) => (
                <li key={`i${i}`}>{line.text}</li>
              ))}
            </ul>
          )}
          {cv.length > 0 && <p className="text-sm">Attach your CV in Gmail.</p>}
          {(view.kitParts?.attachments ?? []).map((attachment) => (
            <AttachTick
              key={attachment.id}
              jobId={view.id}
              id={attachment.id}
              name={attachment.name}
              ticked={decisions.attached.includes(attachment.id)}
              disabled={sent}
            />
          ))}
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
        ) : byEmail ? (
          <MarkSent jobId={view.id} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {role.route.kind === "unknown" || role.route.kind === "other"
              ? "Choosing how to apply, and recording it once sent, comes with the kit-type pick."
              : "Recording an application sent another way comes with form and message kits."}
          </p>
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

/** A judge's finding in the owner's words. */
function judgeWords(verdict: BlockVerdict): string {
  const note = verdict.note ? ` ${verdict.note}` : "";
  if (verdict.verdict === "overstated") {
    return `The separate check says this says more than your facts show.${note}`;
  }
  if (verdict.verdict === "unsupported") {
    return `The separate check found nothing in your facts behind this.${note}`;
  }
  return "This says something about the company that the post does not. Check it, or cut it.";
}

/** Why the contact's second read leaves it to the owner, in their words. */
function contactWords(reason: AgreementProblem, noun: "address" | "number"): string {
  switch (reason) {
    case "disagree":
      return `A second read of the screenshot gives a different ${noun}. Type it yourself from the screenshot.`;
    case "no_second_read":
      return `The ${noun} could not be read a second time. Type it yourself from the screenshot.`;
    case "invalid_box":
      return `jobkit could not find the ${noun} on the screenshot. Type it yourself from the post.`;
    case "no_crop":
      return `jobkit could not cut the ${noun} out of the screenshot. Type it yourself from the post.`;
    case "no_model":
      return `This machine has no Gemini key, so the ${noun} was not read a second time. Type it yourself from the screenshot.`;
    case "bad_number":
      return "jobkit cannot read this number's country code. Check it, and type it yourself from the post.";
    case "not_in_text":
      return `This ${noun} is not in the pasted text as written. Type it yourself from the post.`;
  }
}
