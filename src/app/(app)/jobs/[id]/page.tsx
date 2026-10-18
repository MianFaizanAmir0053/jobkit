import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import type { KitFlag, KitFlagKind } from "@/core/drafting/validate";
import { emailBody } from "@/core/drafting/kit";
import { type BlockVerdict, isBlocking, NEVER_WEIGHED } from "@/core/drafting/verdict";
import type { AgreementProblem } from "@/core/extraction/addressRead";
import { isStrictAddress } from "@/core/extraction/contacts";
import type { Role } from "@/core/extraction/record";
import { flagRank, judgeMessage } from "@/core/review/canHandOff";
import { flagKey, NEEDS_NEW_WORDS, needsNewWords, NO_DECISIONS } from "@/core/review/decisions";
import { gmailComposeUrl } from "@/core/review/gmail";
import type { DraftChoice, JobView, Step } from "@/core/review/jobView";
import { showsFor } from "@/core/review/kitSends";
import { appConfig } from "@/server/config";
import {
  gmailForViewer,
  jobForViewer,
  kitCvForViewer,
  requestTime,
  requireSession,
  viewerTimeZone,
} from "@/server/dal";

import { duplicateLine, formatTime, placeOfFlag, STATE_WORDS, withoutContacts } from "../words";

import { ActionButton } from "./ActionButton";
import { ApproveSend } from "./ApproveSend";
import { JobPoller } from "./JobPoller";
import { MarkSent } from "./MarkSent";
import { Outbound } from "./Outbound";
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
  skipped: "Not needed",
  none_fit: "None fits this role",
};

/**
 * Flags a change to the email's words would resolve. jobkit cannot change
 * them until the block editor exists (Task 29), so on the way through Gmail
 * the owner fixes them there, and answers Yes when asked whether they
 * changed anything. Approve & send sends the words as they stand: it
 * refuses a kit with one of those that make the email wrong to send
 * (NEEDS_NEW_WORDS), and takes the others as they are.
 */
const FIXED_IN_GMAIL: ReadonlySet<KitFlagKind> = new Set([
  "needs_your_line",
  "subject_placeholder",
  "reference_leak",
  "ai_instruction_followed",
  "no_claims",
  "missing_gap_line",
  "over_limit",
  "keyword_missing",
]);

/** Flags that point at one of the role's requirements rather than a sentence. */
const ABOUT_A_REQUIREMENT: ReadonlySet<KitFlagKind> = new Set([
  "fit_unverified",
  "fit_missing",
  "missing_gap_line",
]);

/**
 * The job page (review spec, as far as the thin path goes): the steps as
 * they run, the owner's answers in waiting and stopped states, Retry and
 * Skip after a failure, and the email kit: the banners, the contact, what
 * to check, the checklist and the fit, then Approve & send from the owner's
 * Gmail (decisions A20) and the outbound controls, held by the gate, and
 * Mark sent. It polls while the job runs or uploads.
 */
export default async function JobPage(props: PageProps<"/jobs/[id]">) {
  const session = await requireSession();
  const { id } = await props.params;
  const view = await jobForViewer(id);
  if (!view) notFound();
  const timeZone = await viewerTimeZone();
  // The Google account jobkit signs in with: Gmail opens in it, and the page says to check its From.
  const account = appConfig().ownerEmail;
  const record = view.extraction?.record ?? null;
  const heading = [view.role?.title, record?.company.name].filter(Boolean).join(" · ") || "Job";
  const polling = view.kind === "running" || view.kind === "client";
  const ready = view.state === "kit_ready";
  const readable = ready && view.draft && view.role && view.kitParts && view.kitKey;
  const gmail = readable ? await gmailForViewer() : null;
  const cv = readable ? await kitCvForViewer(view.draft!.profileVersion) : null;
  const now = await requestTime();

  return (
    <section aria-labelledby="job-heading" className="flex flex-col gap-6">
      {polling && <JobPoller jobId={view.id} />}
      <div>
        <Link
          href="/jobs"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:underline"
        >
          ← Jobs
        </Link>
        <h1 id="job-heading" className="text-2xl font-semibold tracking-tight">
          {heading}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {view.application?.status === "bounced"
            ? "Bounced"
            : view.went
              ? "Sent"
              : ready && view.application?.status === "skipped"
                ? "Skipped"
                : STATE_WORDS[view.state]}{" "}
          · started {formatTime(view.receivedAt, timeZone)}
        </p>
      </div>

      <Steps steps={view.steps} />
      <StatePanel view={view} />
      {/* Banners, most serious first: the scam warning, earlier applications, the role's reasons. */}
      {record && <ScamPanel view={view} />}
      {readable && <DuplicatePanel view={view} timeZone={timeZone} />}
      {readable && <EligibilityBanner view={view} />}
      {record && <PostPanel view={view} />}
      {readable ? (
        <KitPanel
          view={view}
          account={account}
          gmail={
            gmail
              ? { state: gmail.refusedAt ? "refused" : "connected", email: gmail.email }
              : { state: "not-connected", email: null }
          }
          cvFile={cv}
          onLaptop={session.kind === "google"}
          now={now}
          timeZone={timeZone}
        />
      ) : (
        ready && (
          <Panel title="This kit cannot be read">
            <p className="text-sm">
              jobkit can no longer read this kit, as after an update. Send the post again as a new
              job.
            </p>
            {view.role && !view.went && <KitSkip view={view} kit={null} timeZone={timeZone} />}
            {view.went && (
              <div className="flex flex-col gap-2 text-sm">
                <Bounce view={view} timeZone={timeZone} />
              </div>
            )}
          </Panel>
        )
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
  // A send of the kit that may have gone, as when a Gemini draft asked for beside it then failed.
  const uncertain = view.uncertain;
  const skip = (
    <ActionButton
      url={`${base}/skip`}
      label="Skip"
      variant="outline"
      body={{ state: view.state, uncertain: uncertain?.id ?? null }}
      confirmText={
        uncertain
          ? "A send of this email may have gone: check your Gmail Sent folder first. Skip this job anyway? It closes for good, and the skip cannot be taken back."
          : "Skip this job? It closes for good."
      }
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
          {uncertain && (
            <p className="rounded-md border border-destructive/40 p-3 text-sm [overflow-wrap:anywhere]">
              A send of this email may have gone: check your Gmail Sent folder.
              {view.canGoBackToDrafts && " If it went, go back to your drafts and press Mark sent."}
            </p>
          )}
          {view.canGoBackToDrafts && (
            <p className="text-sm text-muted-foreground">
              Your templates&apos; drafts are still there: go back to them, or retry Gemini.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {view.canGoBackToDrafts && (
              <ActionButton url={`${base}/back-to-drafts`} label="Back to your drafts" />
            )}
            <ActionButton
              url={`${base}/retry`}
              label="Retry"
              variant={view.canGoBackToDrafts ? "outline" : "default"}
            />
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
          <p>
            The screenshots did not all arrive within 15 minutes. Upload them again, or skip the
            job.
          </p>
          <div className="flex gap-2">
            <Link href={`/jobs/new?again=${view.id}`} className={`${buttonVariants()} min-h-11`}>
              Upload again
            </Link>
            {skip}
          </div>
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

/**
 * The contact the owner must type from the post, whose reading by jobkit
 * the page then never shows, in the post's words either; null when none.
 */
function typing(view: JobView): "email" | "whatsapp" | null {
  const contact = view.kitParts?.contact;
  return contact?.needsRetype ? contact.kind : null;
}

function Panel({
  title,
  danger = false,
  children,
}: {
  title: string;
  /** A warning the owner must not miss: drawn in red, and named in words too. */
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-4 ${danger ? "border-destructive" : "border-border"}`}
    >
      <h2 className={`font-semibold ${danger ? "text-destructive" : ""}`}>{title}</h2>
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
      <span className="text-muted-foreground [overflow-wrap:anywhere]">
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
    <Panel title="Possible scam signs" danger>
      <ul className="list-disc pl-5 text-sm [overflow-wrap:anywhere]">
        {scam.map((signal, i) => (
          <li key={i}>
            {signal.quote ? (
              <>&ldquo;{withoutContacts(signal.quote, typing(view))}&rdquo;</>
            ) : (
              <>A sign the post does not quote: {signal.kind.replaceAll("_", " ")}</>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Never send an ID card, a passport copy, bank details or a fee to apply for a job.
      </p>
      {view.review &&
        (view.review.decisions.continueAnyway ? (
          <p className="text-sm">You chose to continue anyway.</p>
        ) : (
          !view.kitParts?.sent &&
          !view.kitParts?.skipped && (
            <ActionButton
              url={`/api/jobs/${view.id}/review`}
              gateOf={view.id}
              label="Continue anyway"
              variant="destructive"
              confirmText="This post shows signs of a scam. Continue with it anyway?"
              body={{ action: { kind: "continue_anyway" }, kit: view.kitKey }}
            />
          )
        ))}
    </Panel>
  );
}

/** Earlier applications the ledger matched, with "Apply again", until the kit is sent or skipped. */
function DuplicatePanel({ view, timeZone }: { view: JobView; timeZone: string }) {
  const repeats = view.duplicates.filter((match) => !match.covered);
  if (repeats.length === 0 || view.kitParts?.sent || view.kitParts?.skipped) return null;
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
        gateOf={view.id}
        label="Apply again"
        variant="outline"
        body={{ keys: repeats.map((match) => match.key), kit: view.kitKey }}
      />
    </Panel>
  );
}

/** The role's eligibility reasons, with the banners. */
function EligibilityBanner({ view }: { view: JobView }) {
  if (!view.eligibility || view.eligibility.reasons.length === 0) return null;
  return (
    <Panel
      title={
        view.draftedAnyway
          ? "You chose to draft for a role that may not be open to you"
          : "Check these about the role"
      }
    >
      <EligibilityReasons view={view} />
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
          <p className="text-sm">
            jobkit was told not to follow these lines; the checks on the email say if it did.
          </p>
          <ul className="list-disc pl-5 text-sm [overflow-wrap:anywhere]">
            {aimedAtAi.map((line, i) => (
              <li key={i}>&ldquo;{withoutContacts(line, typing(view))}&rdquo;</li>
            ))}
          </ul>
        </Panel>
      )}
      {extraction.flags.length > 0 && (
        <Panel title="Check these against the post">
          <ul className="list-disc pl-5 text-sm [overflow-wrap:anywhere]">
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
  gmail,
  cvFile,
  onLaptop,
  now,
  timeZone,
}: {
  view: JobView;
  account: string;
  /** The Gmail account Approve & send sends from, and whether jobkit can still use it. */
  gmail: { state: "connected" | "not-connected" | "refused"; email: string | null };
  /** The CV Approve & send attaches, as the recruiter sees its name. */
  cvFile: string | null;
  /** Whether this device can open Devices: a paired phone cannot. */
  onLaptop: boolean;
  now: Date;
  timeZone: string;
}) {
  const draft = view.draft!;
  const role = view.role!;
  const parts = view.kitParts!;
  const kitKey = view.kitKey!;
  const kit = draft.kit;
  const body = emailBody(kit);
  const byEmail = role.route.kind === "email";
  const address = role.route.address.trim();
  const blockText = new Map(kit.blocks.map((block) => [block.id, block.text]));
  const requirementText = new Map(role.requirements.map((entry) => [entry.id, entry.text]));
  const aboutFlag = (flag: KitFlag) =>
    ABOUT_A_REQUIREMENT.has(flag.kind)
      ? requirementText.get(flag.at)
      : (blockText.get(flag.at) ?? undefined);
  // The separate check's findings, a sentence it never weighed included.
  const judged = parts.verdicts.filter(isBlocking);
  // validate's flags, most serious first, each with its place among the kit's.
  const flags = [...draft.flags.entries()].sort(
    ([, a], [, b]) => flagRank(a.kind) - flagRank(b.kind),
  );
  const instructions = role.instructions.filter((line) => !line.addressed_to_ai);
  const unchecked = view.steps
    .filter((step) => step.status === "not_checked")
    .map((step) => step.label.toLowerCase());
  const noun = role.route.kind === "whatsapp" ? "number" : "address";
  const disputed =
    view.contact && !view.contact.agreement.ok
      ? contactWords(view.contact.agreement.reason, noun)
      : null;
  const postChecks = view.addressChecks ?? [];
  const unread =
    view.contact === null &&
    (role.route.kind === "email" || role.route.kind === "whatsapp") &&
    address !== "";
  // The outbound gate: every outbound control opens only when no reason holds it back.
  const decisions = view.review?.decisions ?? NO_DECISIONS;
  const gate = view.review?.gate ?? [];
  const open = view.review !== null && gate.length === 0;
  const sent = parts.sent;
  const skipped = parts.skipped;
  // While jobkit sends the email, or the owner has skipped the job, nothing on the page changes it.
  const locked = sent || parts.sending || skipped;
  // The send the page shows beside this kit, by the rule the send's route answers with too.
  const send = view.send && showsFor(view.send, kitKey) ? view.send : null;
  // A send that may have gone, whatever came after it: the page warns until the kit is sent.
  const uncertain = view.uncertain;
  const shown = send && {
    id: send.id,
    status: send.status,
    leftMs: Math.max(0, send.sendAt.getTime() - now.getTime()),
  };
  // The countdown says jobkit is sending it; the list says what else holds it.
  const reasons = gate.filter((reason) => reason.kind !== "sending");
  // Approve & send marks every flagged sentence and flag checked, but for those only new words
  // resolve; the other reasons need the owner.
  const approvals = reasons.flatMap((reason) => {
    if (reason.kind === "judge") {
      return [`${reason.message} — "${blockText.get(reason.blockId) ?? ""}"`];
    }
    if (reason.kind === "flag" && !NEEDS_NEW_WORDS.has(reason.flag.kind)) {
      const about = aboutFlag(reason.flag);
      return [about ? `${reason.message} — "${about}"` : reason.message];
    }
    return [];
  });
  // What Approve & send cannot settle: a file besides the CV, which it cannot attach, words that
  // must change, which it cannot change, and the reasons only the owner can.
  const held =
    parts.attachments.length > 0
      ? "This post asks for a file besides your CV, which jobkit cannot attach: send it yourself with Open in Gmail, and attach the file there."
      : needsNewWords(parts)
        ? "Some of this email's words must change before it goes, which jobkit cannot do: send it yourself with Open in Gmail, and change them there."
        : reasons.some((reason) => reason.kind !== "judge" && reason.kind !== "flag")
          ? "Approve & send marks the sentences and flags above as checked, but the other reasons listed need you first."
          : null;
  const needsRetype = parts.contact?.needsRetype ?? false;
  // Where the kit goes: the post's contact, or the one typed in its place once it passes.
  const to = view.handoff?.to ?? "";
  const typedChecks = needsRetype && to !== "" ? (decisions.retyped?.checks ?? []) : [];
  const checked = new Set(decisions.checked);
  const flagsChecked = new Set(decisions.flagsChecked);
  const reviewUrl = `/api/jobs/${view.id}/review`;
  const goes = role.route.kind === "whatsapp" ? "the message goes to" : "the email goes to";
  const cv = role.required_attachments.filter((attachment) => attachment.is_cv);
  const decision = (action: object) => ({ action, kit: kitKey });

  return (
    <div className="flex flex-col gap-4">
      {(unread || unchecked.length > 0) && (
        <Panel title="Not checked yet">
          {unread && (
            <p className="text-sm">
              This job ran before jobkit read the {noun} a second time, so type it yourself from the
              post.
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

      {(view.drafts.length > 1 || view.canDraftWithGemini) && (
        <DraftPicker view={view} locked={locked} />
      )}

      <Panel title="The email">
        <p className="text-sm text-muted-foreground">{sourceWords(view)}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">To</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            {!byEmail ? (
              <span>
                The post asks you to apply {ROUTE_WORDS[role.route.kind]}
                {role.route.address && !needsRetype && `: ${role.route.address}`}. Use the text
                below there.
              </span>
            ) : !needsRetype ? (
              address
            ) : address === "" ? (
              <span className="text-destructive">
                The post asks you to apply by email, but jobkit found no address in it. Find it in
                the post.
              </span>
            ) : (
              // jobkit's own reading is not shown while it is unconfirmed, so it is never copied.
              <span className="text-destructive">
                jobkit could not confirm the {noun} it read
                {isStrictAddress(address) ? "" : ", and it is not a whole address"}.
              </span>
            )}
            {disputed && <p className="mt-1 text-destructive">{disputed}</p>}
            {needsRetype &&
              to === "" &&
              postChecks
                .filter((check) => check.blocking && check.kind !== "syntax")
                .map((check) => (
                  <p key={check.kind} className="mt-1 text-destructive">
                    The address jobkit read: {check.message}
                  </p>
                ))}
            {!needsRetype &&
              postChecks
                .filter((check) => !check.blocking)
                .map((check) => (
                  <p key={check.kind} className="mt-1 text-muted-foreground">
                    {check.message}
                  </p>
                ))}
            {needsRetype && parts.contact && !locked && (
              <RetypeField
                jobId={view.id}
                kit={kitKey}
                kind={parts.contact.kind}
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
                The address you typed: {check.message}
              </p>
            ))}
            {view.contact?.agreement.ok && !needsRetype && (
              <p className="mt-1 text-muted-foreground">Read a second time: it matches.</p>
            )}
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{kit.subject}</dd>
        </dl>
        <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {body}
        </div>
      </Panel>

      {(flags.length > 0 || judged.length > 0) && (
        <Panel title="Check these before you send">
          {flags.some(([, flag]) => FIXED_IN_GMAIL.has(flag.kind)) && (
            <p className="text-sm text-muted-foreground">
              Some of these need the email&apos;s words changed, which jobkit cannot do yet: change
              them in Gmail before you send, and answer Yes when jobkit asks whether you changed
              anything.
            </p>
          )}
          <ul className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
            {judged.map((verdict) => (
              <li key={`judge-${verdict.blockId}`}>
                {judgeWords(verdict)}
                <span className="text-muted-foreground">
                  {" "}
                  — &ldquo;{blockText.get(verdict.blockId)}&rdquo;
                </span>
                {!locked && (
                  <div className="mt-1 flex items-center gap-2">
                    {checked.has(verdict.blockId) ? (
                      <>
                        <span className="text-muted-foreground">You checked this.</span>
                        <ActionButton
                          url={reviewUrl}
                          gateOf={view.id}
                          label="Undo"
                          variant="outline"
                          body={decision({ kind: "uncheck", blockId: verdict.blockId })}
                        />
                      </>
                    ) : (
                      <ActionButton
                        url={reviewUrl}
                        gateOf={view.id}
                        label="I checked this"
                        variant="outline"
                        body={decision({ kind: "check", blockId: verdict.blockId })}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
            {flags.map(([place, flag]) => {
              const key = flagKey(place);
              const about = aboutFlag(flag);
              const inGmail = FIXED_IN_GMAIL.has(flag.kind);
              return (
                <li key={key}>
                  {flag.message}
                  {about && <span className="text-muted-foreground"> — &ldquo;{about}&rdquo;</span>}
                  {!locked && (
                    <div className="mt-1 flex items-center gap-2">
                      {flagsChecked.has(key) ? (
                        <>
                          <span className="text-muted-foreground">
                            {inGmail ? "You will fix it in Gmail." : "You checked this."}
                          </span>
                          <ActionButton
                            url={reviewUrl}
                            gateOf={view.id}
                            label="Undo"
                            variant="outline"
                            body={decision({ kind: "uncheck_flag", flag: key })}
                          />
                        </>
                      ) : (
                        <ActionButton
                          url={reviewUrl}
                          gateOf={view.id}
                          label={inGmail ? "I will fix it in Gmail" : "I checked this"}
                          variant="outline"
                          body={decision({ kind: "check_flag", flag: key })}
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
            <ul className="list-disc pl-5 text-sm [overflow-wrap:anywhere]">
              {instructions.map((line, i) => (
                <li key={`i${i}`}>{withoutContacts(line.text, typing(view))}</li>
              ))}
            </ul>
          )}
          {cv.length > 0 && (
            <p className="text-sm [overflow-wrap:anywhere]">
              Attach your CV in Gmail. The post asks for:{" "}
              {cv.map((attachment) => attachment.name || "a CV").join("; ")}.
            </p>
          )}
          {parts.attachments.map((attachment) => (
            <AttachTick
              key={attachment.id}
              jobId={view.id}
              kit={kitKey}
              id={attachment.id}
              name={attachment.name}
              ticked={decisions.attached.includes(attachment.id)}
              disabled={locked}
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
                  <td className="py-1 pr-3 [overflow-wrap:anywhere]">
                    {withoutContacts(requirement.text, typing(view))}
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

      <Panel title="Send it">
        {/* One live region for the send's steps, which outlives Approve & send as it is drawn again. */}
        <div aria-live="polite" className="flex flex-col gap-2">
          {byEmail && !sent && send?.status === "scheduled" && (
            <p className="sr-only">jobkit is about to send this email. Press Undo to stop it.</p>
          )}
          {byEmail && !sent && send?.status === "sending" && (
            <p className="sr-only">jobkit is sending this email from your Gmail.</p>
          )}
          {byEmail && !sent && !skipped && send?.status === "failed" && send.error && (
            <p className="text-sm text-destructive [overflow-wrap:anywhere]">{send.error}</p>
          )}
          {byEmail && !sent && !skipped && uncertain?.error && (
            <p className="rounded-md border border-destructive/40 p-3 text-sm [overflow-wrap:anywhere]">
              {uncertain.error}
            </p>
          )}
          {byEmail && !sent && !skipped && send?.status === "cancelled" && (
            <p className="text-sm text-muted-foreground">You pressed Undo, so nothing was sent.</p>
          )}
          {reasons.length > 0 && (
            <div className="rounded-md border border-destructive/40 p-3 text-sm">
              <p className="font-medium">
                {sent ? "Sent already" : skipped ? "Skipped" : "Before you send"}
              </p>
              <ul className="mt-1 list-disc pl-5 [overflow-wrap:anywhere]">
                {reasons.map((reason, i) => {
                  // A sentence's finding names the sentence, so two findings never read alike.
                  const about =
                    reason.kind === "judge"
                      ? blockText.get(reason.blockId)
                      : reason.kind === "flag"
                        ? aboutFlag(reason.flag)
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
              </ul>
            </div>
          )}
        </div>
        {byEmail && !sent && !skipped && (
          <>
            <ApproveSend
              key={shown ? `${shown.id}-${shown.status}` : "none"}
              jobId={view.id}
              kit={kitKey}
              to={to}
              subject={kit.subject}
              gmail={gmail}
              onLaptop={onLaptop}
              cv={cvFile}
              approvals={approvals}
              held={held}
              uncertainId={uncertain?.id ?? null}
              shown={shown}
            />
            <p className="text-sm font-medium">Or send it yourself</p>
          </>
        )}
        <Outbound
          jobId={view.id}
          kit={kitKey}
          open={open}
          to={view.handoff?.to ?? null}
          status={view.application?.status ?? null}
          email={byEmail}
          gmailHref={
            open && byEmail && to !== ""
              ? gmailComposeUrl(to, kit.subject, body, account || null)
              : null
          }
          subject={kit.subject}
          body={body}
        />
        {byEmail && !sent && !skipped && (
          <p className="text-sm text-muted-foreground">
            In Gmail, {account ? `check that From shows ${account}, ` : "check the From address, "}
            attach your CV, and send. Gmail adds your signature. If you change the email&apos;s
            wording in Gmail, answer Yes when jobkit asks; attaching your CV does not count.
          </p>
        )}
      </Panel>

      <Panel title={skipped ? "Not applying" : "After you send it"}>
        {sent ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              {send?.status === "sent"
                ? `Sent from your Gmail${view.application?.sentAt ? ` on ${formatTime(view.application.sentAt, timeZone)}` : ""}.`
                : view.application?.sentAt
                  ? `Marked sent on ${formatTime(view.application.sentAt, timeZone)}.`
                  : "Marked sent."}
            </p>
            {send?.status === "sent" && send.error && (
              <p className="text-destructive [overflow-wrap:anywhere]">{send.error}</p>
            )}
            {view.application?.status === "sent" &&
              view.application.sentAt &&
              send?.status !== "sent" && (
                <div>
                  <ActionButton
                    url={`/api/jobs/${view.id}/take-back`}
                    label="Take back Mark sent"
                    variant="outline"
                    body={{ sentAt: view.application.sentAt.toISOString() }}
                    gateOf={view.id}
                    confirmText="Take back Mark sent? Do this only if you did not send it: the kit opens again."
                  />
                </div>
              )}
            <Bounce view={view} timeZone={timeZone} />
          </div>
        ) : skipped ? (
          <KitSkip view={view} kit={kitKey} timeZone={timeZone} />
        ) : byEmail ? (
          parts.sending ? (
            <p className="text-sm text-muted-foreground">jobkit is sending it.</p>
          ) : open ? (
            <MarkSent jobId={view.id} kit={kitKey} to={to} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Mark sent appears once nothing holds the email back.
            </p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {role.route.kind === "unknown" || role.route.kind === "other"
              ? "Choosing how to apply, and recording it once sent, comes with the kit-type pick."
              : "Recording an application sent another way comes with form and message kits."}
          </p>
        )}
      </Panel>

      {!sent && !parts.sending && !skipped && (
        <Panel title="Not applying?">
          <KitSkip view={view} kit={kitKey} timeZone={timeZone} />
        </Panel>
      )}
    </div>
  );
}

/**
 * Skip on a ready kit (review spec, "Handoffs"), naming the kit the page
 * shows, null when it cannot read one, and the send it warned may have gone;
 * once skipped, when, with "Take back the skip", by the skip it shows, and
 * while a send from before may have gone, how to record it if it did, where
 * the page can.
 */
function KitSkip({ view, kit, timeZone }: { view: JobView; kit: string | null; timeZone: string }) {
  if (view.application?.status === "skipped") {
    const { skippedAt } = view.application;
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          {skippedAt
            ? `You skipped this job on ${formatTime(skippedAt, timeZone)}.`
            : "You skipped this job."}
        </p>
        {view.uncertain && (
          <p className="rounded-md border border-destructive/40 p-3 [overflow-wrap:anywhere]">
            {kit === null
              ? "A send of this email from before you skipped may have gone: check your Gmail Sent folder. This page cannot record it, since jobkit can no longer read this kit."
              : "A send of this email from before you skipped may have gone. Check your Gmail Sent folder: if it went, take the skip back and press Mark sent."}
          </p>
        )}
        {skippedAt && (
          <div>
            <ActionButton
              url={`/api/jobs/${view.id}/take-back`}
              label="Take back the skip"
              variant="outline"
              body={{ skippedAt: skippedAt.toISOString() }}
              gateOf={view.id}
            />
          </div>
        )}
      </div>
    );
  }
  const uncertain = view.uncertain;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Skip this job: nothing goes out, its kit stays here, and you can take the skip back.
      </p>
      <div>
        <ActionButton
          url={`/api/jobs/${view.id}/skip`}
          label="Skip this job"
          variant="outline"
          body={{ kit, uncertain: uncertain?.id ?? null }}
          gateOf={view.id}
          confirmText={
            uncertain
              ? "A send of this email may have gone: check your Gmail Sent folder first. Skip this job anyway? Nothing more goes out, and you can take the skip back on this page."
              : "Skip this job? Nothing goes out, and you can take the skip back on this page."
          }
        />
      </div>
    </div>
  );
}

/**
 * Mark bounced on a sent email (review spec, "Handoffs"), by the Mark sent
 * the page shows; once bounced, when, with "Take back Mark bounced", by the
 * bounce it shows.
 */
function Bounce({ view, timeZone }: { view: JobView; timeZone: string }) {
  const application = view.application;
  if (application?.status === "bounced") {
    return (
      <>
        <p>
          {application.bouncedAt
            ? `You marked it bounced on ${formatTime(application.bouncedAt, timeZone)}.`
            : "You marked it bounced."}
        </p>
        {application.bouncedAt && (
          <div>
            <ActionButton
              url={`/api/jobs/${view.id}/take-back`}
              label="Take back Mark bounced"
              variant="outline"
              body={{ bouncedAt: application.bouncedAt.toISOString() }}
              gateOf={view.id}
            />
          </div>
        )}
      </>
    );
  }
  if (application?.status !== "sent" || !application.sentAt) return null;
  return (
    <div>
      <ActionButton
        url={`/api/jobs/${view.id}/bounced`}
        label="Mark bounced"
        variant="outline"
        body={{ sentAt: application.sentAt.toISOString() }}
        gateOf={view.id}
        confirmText="Did this email come back undelivered? Mark it bounced: you can take it back."
      />
    </div>
  );
}

/** A draft by whose words it holds. */
function draftName(draft: DraftChoice): string {
  return draft.source === "template" ? `Your template: ${draft.name}` : "Gemini's draft";
}

/** Where the email shown came from, and so what checked its sentences. */
function sourceWords(view: JobView): string {
  const draft = view.drafts.find((each) => each.id === view.picked);
  if (draft?.source !== "template") {
    return view.judge
      ? "Gemini wrote this from your approved facts, and a separate check weighed every sentence."
      : "Gemini wrote this from your approved facts. No separate check weighed it, so check each sentence against your facts.";
  }
  return `Written from your approved template "${draft.name}", with the post's company and role, and your approved facts and gap lines for what the template does not cover.`;
}

/**
 * The kit's drafts, best first, the first recommended (decisions A21): the
 * one shown is the kit, and showing another makes that one the kit. Below
 * them, while only the templates drafted it, Gemini can write one too.
 */
function DraftPicker({ view, locked }: { view: JobView; locked: boolean }) {
  return (
    <Panel title="Drafts">
      <ol className="flex flex-col gap-2">
        {view.drafts.map((draft, rank) => {
          const shown = draft.id === view.picked;
          return (
            <li
              key={draft.id}
              aria-current={shown ? "true" : undefined}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 ${shown ? "border-foreground" : "border-border"}`}
            >
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="font-medium [overflow-wrap:anywhere]">
                  {rank === 0 && (
                    <span className="mr-2 rounded-sm bg-foreground px-1.5 py-0.5 text-xs text-background">
                      Recommended
                    </span>
                  )}
                  {draftName(draft)}
                </span>
                <span className="text-muted-foreground">
                  Covers {Math.round(draft.coverage * 100)}% of the must-haves ·{" "}
                  {draft.open === 0
                    ? "nothing flagged"
                    : `${draft.open} ${draft.open === 1 ? "thing" : "things"} to check`}{" "}
                  · {draft.words} words
                </span>
              </div>
              {shown ? (
                <span className="text-sm text-muted-foreground">Shown below</span>
              ) : (
                !locked && (
                  <ActionButton
                    url={`/api/jobs/${view.id}/pick`}
                    gateOf={view.id}
                    label="Show this one"
                    variant="outline"
                    body={{ draft: draft.id, kit: view.kitKey }}
                  />
                )
              )}
            </li>
          );
        })}
      </ol>
      {view.canDraftWithGemini && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Your templates drafted this email, so Gemini has not written one. Gemini takes about a
            minute, and its draft then shows here beside these.
          </p>
          <div>
            <ActionButton
              url={`/api/jobs/${view.id}/draft-with-gemini`}
              gateOf={view.id}
              label="Write a draft with Gemini too"
              variant="outline"
              body={{ kit: view.kitKey }}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

/** What the eligibility check found, each with the post's words. */
function EligibilityReasons({ view }: { view: JobView }) {
  const reasons = view.eligibility?.reasons ?? [];
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm [overflow-wrap:anywhere]">
      {reasons.map((reason, i) => (
        <li key={i}>
          {reason.message}
          {reason.quote && (
            <span className="text-muted-foreground">
              {" "}
              — &ldquo;{withoutContacts(reason.quote, typing(view))}&rdquo;
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A judge's finding in the owner's words, as the gate gives it, with the judge's note. */
function judgeWords(verdict: BlockVerdict): string {
  const note = verdict.note && verdict.note !== NEVER_WEIGHED ? ` ${verdict.note}` : "";
  return `${judgeMessage(verdict)}${note}`;
}

/** Why the contact's second read leaves it to the owner, in their words. */
function contactWords(reason: AgreementProblem, noun: "address" | "number"): string {
  switch (reason) {
    case "disagree":
      return `A second read of the screenshot gives a different ${noun}. Type it yourself from your screenshot of the post.`;
    case "no_second_read":
      return `The ${noun} could not be read a second time. Type it yourself from your screenshot of the post.`;
    case "invalid_box":
      return `jobkit could not find the ${noun} on the screenshot. Type it yourself from the post.`;
    case "no_crop":
      return `jobkit could not cut the ${noun} out of the screenshot. Type it yourself from the post.`;
    case "no_model":
      return `This machine has no Gemini key, so the ${noun} was not read a second time. Type it yourself from your screenshot of the post.`;
    case "bad_number":
      return "jobkit cannot read this number's country code. Check it, and type it yourself from the post.";
    case "not_in_text":
      return `This ${noun} is not in the pasted text as written. Type it yourself from the post.`;
  }
}
