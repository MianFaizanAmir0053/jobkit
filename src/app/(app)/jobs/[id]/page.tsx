import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import type { KitFlag, KitFlagKind } from "@/core/drafting/validate";
import { NEEDS_YOUR_LINE } from "@/core/drafting/build";
import {
  emailBody,
  type KitBlock,
  MESSAGE_LIMIT,
  messageLength,
  messageText,
  formText,
  coverNoteText,
} from "@/core/drafting/kit";
import { type BlockVerdict, isBlocking, NEVER_WEIGHED } from "@/core/drafting/verdict";
import type { AgreementProblem } from "@/core/extraction/addressRead";
import { isStrictAddress } from "@/core/extraction/contacts";
import type { Role } from "@/core/extraction/record";
import { flagRank, judgeMessage } from "@/core/review/canHandOff";
import { type ChecklistStatus, checklistOf } from "@/core/review/checklist";
import {
  approvals,
  approvalsKey,
  flagKey,
  isAdded,
  isDeleted,
  isEdited,
  isMeetable,
  MAX_ADDED,
  MAX_SENTENCE,
  NEEDS_NEW_WORDS,
  needsNewWords,
  NO_DECISIONS,
} from "@/core/review/decisions";
import { listedSentences } from "@/core/review/edits";
import { fitTableOf } from "@/core/review/fitTable";
import { gmailComposeUrl } from "@/core/review/gmail";
import { whatsAppLink, applicationLink, linkRefusal } from "@/core/review/links";
import type { DraftChoice, JobView, Step } from "@/core/review/jobView";
import { showsFor } from "@/core/review/kitSends";
import type { PostImages } from "@/core/review/postImages";
import { appConfig } from "@/server/config";
import {
  gmailForViewer,
  jobForViewer,
  kitCvForViewer,
  kitFactsForViewer,
  postImagesForViewer,
  requestTime,
  requireSession,
  viewerTimeZone,
} from "@/server/dal";

import { duplicateLine, formatTime, placeOfFlag, STATE_WORDS, withoutContacts } from "../words";

import { ActionButton } from "./ActionButton";
import { AddScreenshots } from "./AddScreenshots";
import { ApproveSend } from "./ApproveSend";
import { JobPoller } from "./JobPoller";
import { MarkSent } from "./MarkSent";
import { Outbound } from "./Outbound";
import { CROP_KEY } from "./imageUrls";
import { PostImage } from "./PostImage";
import {
  AddSentence,
  AnswersPick,
  AttachTick,
  FitTick,
  RetypeField,
  SentenceEdit,
  WordsDrawn,
} from "./Review";

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

const CHECKLIST_WORDS: Readonly<Record<ChecklistStatus, string>> = {
  applied: "Applied",
  applied_missed: "Applied, but missed: see the checks above",
  declined: "You chose not to apply it: the kit is no longer held to it",
  left_out: "Left out: it repeats a line aimed at AI",
  attachment: "For you to attach",
  not_applied: "Not applied",
  not_followed: "Not followed: addressed to AI",
  followed: "Addressed to AI, and the email repeats it: take it out",
  not_answered: "Not answered",
};

const VERDICT_WORDS: Readonly<Record<"met" | "partial" | "gap", string>> = {
  met: "Met",
  partial: "Partial",
  gap: "Gap",
};

const STEP_WORDS: Readonly<Record<Step["status"], string>> = {
  done: "Done",
  running: "Working…",
  failed: "Failed",
  waiting: "",
  not_checked: "Not checked yet",
  skipped: "Not needed",
  none_fit: "None fits this role",
  not_email: "Not for this kit: your templates are emails",
};

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
  const facts = readable
    ? await kitFactsForViewer(view.draft!.profileVersion)
    : new Map<string, string>();
  // The contact's crop beside it, and the screenshots when the owner must type it from them.
  const images = view.images ? await postImagesForViewer(view.id, view.images) : null;
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
            : view.application?.status === "submitted"
              ? "Submitted"
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
      {record && <PostPanel view={view} withAiLines={!readable} />}
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
          facts={facts}
          images={images}
          onLaptop={session.kind === "google"}
          now={now}
          timeZone={timeZone}
        />
      ) : (
        ready && (
          <Panel title="This kit cannot be read">
            <p className="text-sm">
              jobkit can no longer read this kit, as after an update.
              {!view.went &&
                view.application?.status !== "skipped" &&
                " Send the post again as a new job."}
            </p>
            {view.role && !view.went && <KitSkip view={view} kit={null} timeZone={timeZone} />}
            {view.went && (
              <div className="flex flex-col gap-2 text-sm">
                <Bounce view={view} timeZone={timeZone} />
                <Submitted view={view} timeZone={timeZone} canTakeBack={false} />
              </div>
            )}
          </Panel>
        )
      )}
      <KeepPanel view={view} />
    </section>
  );
}

/** The states whose page offers no keep: screenshots not all arrived, and a manual run. */
const UNKEPT_STATES: ReadonlySet<string> = new Set(["uploading", "upload_failed", "manual_run"]);

/**
 * "Keep for evaluation" (evals spec, "Case sources"): the job's screenshots
 * stay until `npm run eval:pull` copies them into a case. Only for a job
 * with screenshots, where the keep flag lives, once they have all arrived:
 * "Upload again" makes them anew, unkept. Not on a manual run, whose page
 * shows nothing else (ledger spec).
 */
function KeepPanel({ view }: { view: JobView }) {
  if (view.keptForEval === null || UNKEPT_STATES.has(view.state)) return null;
  return (
    <Panel title="For evaluation">
      <p className="text-sm text-muted-foreground">
        {view.keptForEval
          ? "Kept: its screenshots stay until npm run eval:pull copies them into a case for jobkit's evaluation."
          : "Keep this job's screenshots for jobkit's evaluation: they stay until npm run eval:pull copies them into a case."}
      </p>
      <div>
        <ActionButton
          url={`/api/jobs/${view.id}/keep`}
          label={view.keptForEval ? "Don't keep it" : "Keep for evaluation"}
          variant="outline"
          body={{ kept: !view.keptForEval }}
        />
      </div>
    </Panel>
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
      body={{
        state: view.state,
        since: view.stateChangedAt.toISOString(),
        uncertain: uncertain?.id ?? null,
      }}
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
          {/* More of the post, read again whole (intake spec, item 4). */}
          <AddScreenshots jobId={view.id} since={view.stateChangedAt.toISOString()} form={false} />
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
    case "needs_kit_type":
      return (
        <Panel title="How do you apply for this one?">
          <p className="text-sm">
            jobkit could not tell from the post how it wants applications. Choose the kind of kit to
            draft: an email, the answers for an application form, or a short message for WhatsApp or
            LinkedIn.
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["email", "An email"],
                ["form", "An application form"],
                ["message", "A message"],
              ] as const
            ).map(([kit, label]) => (
              <ActionButton
                key={kit}
                url={`${base}/kit-type`}
                label={label}
                body={{ kit, since: view.stateChangedAt.toISOString() }}
              />
            ))}
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
              body={{
                action: { kind: "continue_anyway" },
                kit: view.kitKey,
                words: view.wordsKey,
              }}
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

/**
 * What the post says before there is a kit to check it against: the lines
 * aimed at AI tools, which a kit's checklist shows in their place, and
 * what extract asks the owner to check.
 */
function PostPanel({ view, withAiLines }: { view: JobView; withAiLines: boolean }) {
  const extraction = view.extraction!;
  // From every role, once each: the model may record a line about the whole post under one role.
  const lines = (withAiLines ? extraction.record.roles : []).flatMap((role) => [
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
            jobkit was told not to follow these lines; the checks on what it drafts say if it did.
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
  facts,
  images,
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
  /** The statements of the facts the draft's profile version holds, by ID, for the fit table. */
  facts: ReadonlyMap<string, string>;
  /** The contact's crop and the post's screenshots, signed for 60 seconds; null for none. */
  images: PostImages | null;
  /** Whether this device can open Devices: a paired phone cannot. */
  onLaptop: boolean;
  now: Date;
  timeZone: string;
}) {
  const draft = view.draft!;
  const role = view.role!;
  const parts = view.kitParts!;
  const kitKey = view.kitKey!;
  // The email's words as this page shows them, which each of its decisions and Send names.
  const words = view.wordsKey!;
  // The email or message as it stands, with the owner's edits: what every handoff sends.
  const kit = view.kit ?? draft.kit;
  const body =
    kit.kind === "email"
      ? emailBody(kit)
      : kit.kind === "message"
        ? messageText(kit)
        : formText(kit);
  // What the panel calls it: the email, or the message for WhatsApp or LinkedIn, or the form.
  const kitNoun = kit.kind;
  // An email kit goes through Gmail; a form or message is sent where the owner applies.
  const byEmail = view.kitRoute === "email";
  const where = byEmail ? "in Gmail" : "where you apply";
  const address = role.route.address.trim();
  // A form, its answers as they stand, and the https link it goes through, if the post gives one.
  const form = kit.kind === "form" ? kit : null;
  const applyAt = form ? applicationLink(address) : null;
  // A form's question for each answer, in the post's words, a contact hidden while it is typed.
  const questionText = new Map(
    (form?.answers ?? []).map((answer) => [
      answer.id,
      withoutContacts(answer.question, typing(view)),
    ]),
  );
  // Each sentence's words, and each answer's, which a finding on it names.
  const blockText = new Map([
    ...kit.blocks.map((block): [string, string] => [block.id, block.text]),
    ...(form?.answers ?? []).map((answer): [string, string] => [answer.id, answer.text]),
  ]);
  const requirementText = new Map(role.requirements.map((entry) => [entry.id, entry.text]));
  // A requirement's words are the post's, so a contact in them is hidden while it is typed. A flag
  // on a form's answer names its question.
  const aboutFlag = (flag: KitFlag) => {
    if (questionText.has(flag.at)) return questionText.get(flag.at);
    if (!ABOUT_A_REQUIREMENT.has(flag.kind)) return blockText.get(flag.at) ?? undefined;
    const text = requirementText.get(flag.at);
    return text === undefined ? undefined : withoutContacts(text, typing(view));
  };
  // A finding's sentence, quoted; an answer with its question, as two answers may read alike ("Yes").
  const quoted = (blockId: string): string => {
    const words = `“${blockText.get(blockId) ?? ""}”`;
    const question = questionText.get(blockId);
    return question === undefined ? words : `${words}, your answer to “${question}”`;
  };
  // validate's flags, most serious first; each named by what it found (flagKey).
  const flags = [...parts.flags].sort((a, b) => flagRank(a.kind) - flagRank(b.kind));
  // What the post asks of applicants, each line marked as drafting dealt with it.
  const checklist = checklistOf(
    view.extraction!.record,
    role,
    { ...draft, kit, flags: [...parts.flags] },
    view.review?.decisions.declined ?? [],
  );
  // Each requirement with its verdict, its cited facts, and the owner's tick where only they can.
  const fitRows = fitTableOf(role, { fit: draft.fit, flags: [...parts.flags] });
  // The flags "I meet this requirement" clears, each with its requirement.
  const meetable = new Map(
    fitRows.flatMap((row): [string, string][] =>
      row.tick && row.flag ? [[row.flag, row.id]] : [],
    ),
  );
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
  const meets = new Set(decisions.meets);
  const checked = new Set(decisions.checked);
  const flagsChecked = new Set(decisions.flagsChecked);
  const confirmedEdits = new Set(decisions.confirmed);
  // The separate check's findings, a sentence it never weighed included, but on the drafted words
  // of a sentence the owner put in their own: theirs wait for their confirmation instead.
  const judged = parts.verdicts.filter(
    (verdict) =>
      isBlocking(verdict) &&
      !isEdited(decisions, verdict.blockId) &&
      !isDeleted(decisions, verdict.blockId),
  );
  const draftedText = new Map(draft.kit.blocks.map((block) => [block.id, block.text]));
  const draftedForm = draft.kit.kind === "form" ? draft.kit : null;
  // A gap line only the owner can write, as drafting left it: what to write, in place of its
  // placeholder.
  const yourLine = (block: KitBlock): string | undefined => {
    if (block.text !== NEEDS_YOUR_LINE || !block.gap) return undefined;
    const requirement = requirementText.get(block.gap.requirementId);
    return requirement === undefined
      ? "Write this line yourself."
      : `Write your line about “${withoutContacts(requirement, typing(view))}”: no gap line in your profile fits it.`;
  };
  // The chosen role's must-haves: one the owner does not meet needs a line saying so.
  const musts = new Set(parts.mustHaves ?? []);
  // The must-haves a line in the owner's words answers in the email as it stands.
  const lined = new Set(parts.ownLines ?? []);
  // Each sentence of the owner's that is a gap line, with the must-have it answers.
  const lineOf = new Map(
    kit.blocks.flatMap((block): [string, string][] =>
      block.owner && block.class === "gap" && block.gap
        ? [[block.id, block.gap.requirementId]]
        : [],
    ),
  );
  // The must-haves a line of the owner's may answer: each with no honest line, each only they can
  // confirm they meet, and each a line of theirs answers now.
  const lineFor = [
    ...new Set([
      ...parts.flags
        .filter(
          (flag) => flag.kind === "missing_gap_line" || (isMeetable(flag) && musts.has(flag.at)),
        )
        .map((flag) => flag.at),
      ...lined,
    ]),
  ].flatMap((id) => {
    const text = requirementText.get(id);
    return text === undefined ? [] : [{ id, text: withoutContacts(text, typing(view)) }];
  });
  const gate = view.review?.gate ?? [];
  const open = view.review !== null && gate.length === 0;
  const sent = parts.sent;
  const skipped = parts.skipped;
  // While jobkit sends the email, or the owner has skipped the job, nothing on the page changes it.
  const locked = sent || parts.sending || skipped;
  // The email's sentences as the page lists them, each the owner deleted in its place; when the kit
  // is locked, the email as it went.
  const sentences = locked
    ? kit.blocks.map((block) => ({ block, deleted: false }))
    : listedSentences(draft.kit, decisions);
  // The email keeps at least one sentence: its last offers no Delete.
  const last = sentences.filter((sentence) => !sentence.deleted).length <= 1;
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
  // What Approve & send marks, as the server will: the flagged sentences and flags the gate holds,
  // but for those only new words resolve and those only the owner can answer. The confirmation
  // lists them and the press names them, so it never marks what the page did not list.
  const marks = approvals(parts, decisions);
  const approved = approvalsKey(parts, decisions);
  const approvalLines = marks.map((mark) => {
    if ("blockId" in mark) {
      const reason = reasons.find((each) => each.kind === "judge" && each.blockId === mark.blockId);
      return `${reason?.message ?? "The separate check holds this sentence."} — "${blockText.get(mark.blockId) ?? ""}"`;
    }
    const about = aboutFlag(mark.flag);
    // Its place too, so a flag on the subject and one on the greeting read apart.
    const place =
      mark.flag.at === "subject"
        ? " (the subject)"
        : mark.flag.at === "greeting"
          ? " (the greeting)"
          : "";
    return withoutContacts(
      about ? `${mark.flag.message} — "${about}"` : `${mark.flag.message}${place}`,
      typing(view),
    );
  });
  // The must-haves the owner said they will fix in Gmail, not meeting them.
  const unmet = fitRows.filter(
    (row) =>
      row.tick &&
      row.must &&
      row.flag !== null &&
      flagsChecked.has(row.flag) &&
      !meets.has(row.id) &&
      !lined.has(row.id),
  ).length;
  // What Approve & send cannot settle: a file besides the CV, which it cannot attach, words that
  // must change, which it cannot change, and the reasons only the owner can.
  const held =
    parts.attachments.length > 0
      ? "This post asks for a file besides your CV, which jobkit cannot attach: send it yourself with Open in Gmail, and attach the file there."
      : needsNewWords(parts, decisions)
        ? "Some of this email's words must change before it goes: change them above where you can, or send it yourself with Open in Gmail and change them there."
        : reasons.some((reason) => reason.kind === "flag" && isMeetable(reason.flag))
          ? "Only you can say whether you meet a requirement above: tick it under How you fit, or say you will fix the email, first."
          : reasons.some((reason) => reason.kind !== "judge" && reason.kind !== "flag")
            ? "Approve & send marks the sentences and flags above as checked, but the other reasons listed need you first."
            : null;
  const needsRetype = parts.contact?.needsRetype ?? false;
  // The post's screenshots the page could sign: the one the contact was read on first, when its
  // box lies on one; the rest open on a tap, so a phone fetches them only then.
  const shots = images?.screenshots ?? [];
  const readOnFirst = shots[0] !== undefined && shots[0].position === view.contactScreenshot;
  // Whether the post came as screenshots, as its reading's tiles say, whatever storage still holds.
  const fromScreenshots = (view.extraction?.tiles.length ?? 0) > 0;
  // Where to type the contact from, when the reads agree but there is no crop of it to show.
  const typeFrom = shots.length > 0 ? "the post's screenshots below" : "the post";
  // Where the kit goes: the post's contact, or the one typed in its place once it passes.
  const to = view.handoff?.to ?? "";
  const typedChecks = needsRetype && to !== "" ? (decisions.retyped?.checks ?? []) : [];
  const reviewUrl = `/api/jobs/${view.id}/review`;
  const goes = role.route.kind === "whatsapp" ? "the message goes to" : "the email goes to";
  const cv = role.required_attachments.filter((attachment) => attachment.is_cv);
  const decision = (action: object) => ({ action, kit: kitKey, words });

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

      <WordsDrawn jobId={view.id} words={words} />
      <Panel
        title={
          kit.kind === "email" ? "The email" : kit.kind === "message" ? "The message" : "The form"
        }
      >
        <p className="text-sm text-muted-foreground">{sourceWords(view)}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">To</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            {view.went && view.wentTo ? (
              <>
                <span className="block text-muted-foreground">It went to</span>
                <span className="text-xl font-medium">{view.wentTo}</span>
              </>
            ) : !byEmail ? (
              <>
                {role.route.kind === "other" || role.route.kind === "unknown" ? (
                  // A post that does not say how to apply: how the owner chose to, once they have.
                  <span>
                    {view.kitRoute === null
                      ? "The post does not say how to apply"
                      : `You chose ${view.kitRoute === "form" ? "an application form" : "a message"} for this post, which does not say where to send it`}
                    {role.route.address ? `: it says ${role.route.address}` : ""}. Find out before
                    you apply.
                  </span>
                ) : (
                  <span>
                    The post asks you to apply {ROUTE_WORDS[role.route.kind]}
                    {role.route.kind !== "whatsapp" &&
                      role.route.address &&
                      !needsRetype &&
                      `: ${applyAt ?? role.route.address}`}
                    {kit.kind === "email"
                      ? ". The text below is drafted as an email: adapt it there."
                      : "."}
                  </span>
                )}
                {/* A link to apply through that is not https is shown, never opened (review spec, "Handoffs"). */}
                {form && address !== "" && applyAt === null && (
                  <span className="mt-1 block text-destructive">
                    {linkRefusal(address)}, so jobkit does not open it: check it before you visit
                    it.
                  </span>
                )}
                {/* The number in large type, to check against the post (review spec, "Contact panel"). */}
                {role.route.kind === "whatsapp" && address !== "" && !needsRetype && (
                  <span className="mt-1 block text-xl font-medium">{address}</span>
                )}
              </>
            ) : !needsRetype ? (
              <span className="text-xl font-medium">{address}</span>
            ) : role.route.kind !== "email" ? (
              // An email the owner picked for a post that does not say how to apply.
              <span className="text-destructive">
                You chose to apply by email, and the post gives no address: type the one you will
                send it to.
              </span>
            ) : address === "" ? (
              <span className="text-destructive">
                The post asks you to apply by email, but jobkit found no address in it. Find it in
                the post.
              </span>
            ) : view.noCrop ? (
              // Nor is it shown with no crop beside it to check it against.
              <span className="text-destructive">
                jobkit has no cut-out of the {noun} to show beside its reading
                {isStrictAddress(address) ? "" : ", and it is not a whole address"}, so type it
                yourself from {typeFrom}.
              </span>
            ) : (
              // jobkit's own reading is not shown while it is unconfirmed, so it is never copied.
              <span className="text-destructive">
                jobkit could not confirm the {noun} it read
                {isStrictAddress(address) ? "" : ", and it is not a whole address"}.
              </span>
            )}
            {!byEmail && view.noCrop && (
              <p className="mt-1 text-destructive">
                jobkit has no cut-out of the {noun} to show beside its reading, so type it yourself
                from {typeFrom}.
              </p>
            )}
            {disputed && !view.went && <p className="mt-1 text-destructive">{disputed}</p>}
            {images?.crop && (
              <div className="mt-2 flex flex-col gap-1">
                {needsRetype && (
                  <p className="text-muted-foreground">
                    jobkit&apos;s cut-out of the post where it read the {noun}, enlarged. It may
                    show the wrong spot: type what the post itself says.
                  </p>
                )}
                {/* Tall enough to read: a long one scrolls sideways rather than shrinking. */}
                <div
                  className="overflow-x-auto"
                  tabIndex={0}
                  role="region"
                  aria-label={`The ${noun}'s cut-out, scrolling sideways`}
                >
                  <PostImage
                    key={view.contact?.cropPath}
                    jobId={view.id}
                    imageKey={CROP_KEY}
                    src={images.crop}
                    alt={`The ${noun} in the post's screenshot, enlarged`}
                    className="h-24 w-auto max-w-none rounded border border-border"
                    failedWords="The cut-out did not load. Reload the page to see the post's screenshots in its place."
                  />
                </div>
              </div>
            )}
            {needsRetype &&
              to === "" &&
              !view.went &&
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
                words={words}
                kind={parts.contact.kind}
                value={decisions.retyped?.value ?? null}
              />
            )}
            {needsRetype && to !== "" && !view.went && (
              <p className="mt-1">
                You typed it: {goes}
                <span className="block text-xl font-medium">{to}</span>
              </p>
            )}
            {(view.went ? [] : typedChecks).map((check) => (
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
          {view.images?.screenshots === "always" && shots.length === 0 && fromScreenshots && (
            <dd className="col-span-2 text-muted-foreground">
              jobkit cannot show the post&apos;s screenshots just now. Reload the page to try again.
            </dd>
          )}
          {shots.length > 0 && (
            // The panel's whole width, below the field the contact is typed in.
            <dd className="col-span-2 flex min-w-0 flex-col gap-2">
              <p className="text-muted-foreground">
                {view.went ? (
                  <>
                    The post&apos;s screenshots, to check the {noun} it went to against
                    {readOnFirst && ", the one jobkit read it on first"}.
                  </>
                ) : needsRetype ? (
                  <>
                    The post&apos;s screenshots, to type the {noun} from
                    {readOnFirst && ", the one jobkit read it on first"}. Zoom in to read it.
                  </>
                ) : (
                  <>
                    jobkit cannot show its cut-out of the {noun} just now, so here are the
                    post&apos;s screenshots to check it against.
                  </>
                )}
              </p>
              <PostImage
                key={shots[0]!.id}
                jobId={view.id}
                imageKey={shots[0]!.id}
                src={shots[0]!.url}
                width={shots[0]!.width}
                height={shots[0]!.height}
                alt={`Screenshot ${shots[0]!.position + 1} of the post`}
                className="h-auto w-full rounded border border-border"
              />
              {shots.length > 1 && (
                <details>
                  <summary className="min-h-11 cursor-pointer py-2">
                    Show the other {shots.length - 1} screenshot{shots.length > 2 ? "s" : ""}
                  </summary>
                  <div className="flex flex-col gap-2">
                    {shots.slice(1).map((shot) => (
                      <PostImage
                        key={shot.id}
                        jobId={view.id}
                        imageKey={shot.id}
                        src={shot.url}
                        width={shot.width}
                        height={shot.height}
                        loading="lazy"
                        alt={`Screenshot ${shot.position + 1} of the post`}
                        className="h-auto w-full rounded border border-border"
                      />
                    ))}
                  </div>
                </details>
              )}
            </dd>
          )}
          {kit.kind === "email" && (
            <>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">{kit.subject}</dd>
            </>
          )}
        </dl>
        {/* The body sentence by sentence, each of which the owner may put in their own words. */}
        <div className="rounded-md bg-muted p-3 text-sm [overflow-wrap:anywhere]">
          {kit.kind === "email" && <p className="mb-3 whitespace-pre-wrap">{kit.greeting}</p>}
          {form && <p className="mb-2 font-medium">Cover note</p>}
          <ol className="flex flex-col gap-1">
            {sentences.map(({ block, deleted }, i) => {
              const edited = isEdited(decisions, block.id);
              const added = isAdded(decisions, block.id);
              const confirmed = confirmedEdits.has(block.id);
              // A new paragraph begins after the sentence that ends one.
              const opens = sentences[i - 1]?.block.paragraphBreak === true;
              if (deleted) {
                return (
                  <li key={block.id} className={opens ? "mt-3" : undefined}>
                    <p className="py-2.5 whitespace-pre-wrap text-muted-foreground line-through">
                      {block.text}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">You deleted this sentence.</span>
                      <ActionButton
                        url={reviewUrl}
                        gateOf={view.id}
                        label="Undo delete"
                        ariaLabel={`Undo delete: ${block.text}`}
                        variant="outline"
                        body={decision({ kind: "revert", blockId: block.id })}
                      />
                    </div>
                  </li>
                );
              }
              return (
                <li key={block.id} className={opens ? "mt-3" : undefined}>
                  {locked ? (
                    <p className="whitespace-pre-wrap">{block.text}</p>
                  ) : (
                    <SentenceEdit
                      // By the sentence alone: a box open as the page is drawn on another kit keeps
                      // what the owner typed, and says so when the sentence's words changed.
                      key={block.id}
                      jobId={view.id}
                      kit={kitKey}
                      words={words}
                      blockId={block.id}
                      text={block.text}
                      maxLength={MAX_SENTENCE}
                      prompt={yourLine(block)}
                      added={added}
                      last={last}
                    />
                  )}
                  {edited && (
                    <p className="mt-1 text-muted-foreground">
                      {draftedText.get(block.id) === NEEDS_YOUR_LINE ? (
                        "Your line, which jobkit could not write."
                      ) : (
                        <>Your words. Drafted as: &ldquo;{draftedText.get(block.id) ?? ""}&rdquo;</>
                      )}
                    </p>
                  )}
                  {(edited || added) && !locked && (
                    <p className={confirmed ? "mt-1 text-muted-foreground" : "mt-1 font-medium"}>
                      {confirmed
                        ? "You confirmed your words."
                        : added
                          ? "You added this sentence: confirm it says only what is true."
                          : "You changed this sentence: confirm it says only what is true."}
                    </p>
                  )}
                  {(edited || added) && !locked && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {!confirmed && (
                        <ActionButton
                          url={reviewUrl}
                          gateOf={view.id}
                          label="Confirm"
                          ariaLabel={`Confirm your words: ${block.text}`}
                          variant="outline"
                          body={decision({ kind: "confirm", blockId: block.id })}
                        />
                      )}
                      {added ? (
                        !last && (
                          <ActionButton
                            url={reviewUrl}
                            gateOf={view.id}
                            label="Delete"
                            ariaLabel={`Delete your sentence: ${block.text}`}
                            confirmText="Delete your sentence? It cannot be brought back."
                            variant="outline"
                            body={decision({ kind: "delete", blockId: block.id })}
                          />
                        )
                      ) : (
                        <ActionButton
                          url={reviewUrl}
                          gateOf={view.id}
                          label="Undo edit"
                          ariaLabel={`Undo edit: ${block.text}`}
                          variant="outline"
                          body={decision({ kind: "revert", blockId: block.id })}
                        />
                      )}
                    </div>
                  )}
                  {/* A merged line in a message answers several must-haves: each is named. */}
                  {block.alsoAnswers && block.alsoAnswers.length > 0 && !locked && (
                    <p className="mt-1 text-muted-foreground">
                      One line for{" "}
                      {[block.gap?.requirementId ?? "", ...block.alsoAnswers]
                        .map((id) => requirementText.get(id))
                        .filter((text) => text !== undefined)
                        .map((text) => `“${withoutContacts(text, typing(view))}”`)
                        .join(" and ")}
                      : keep each in it when you change it.
                      {edited && " Picking one below makes it your line about that one alone."}
                    </p>
                  )}
                  {(edited || added) && !locked && lineFor.length > 0 && (
                    <div className="mt-1">
                      <AnswersPick
                        key={`${kitKey}:${block.id}`}
                        jobId={view.id}
                        kit={kitKey}
                        words={words}
                        blockId={block.id}
                        sentence={block.text}
                        value={lineOf.get(block.id) ?? ""}
                        options={lineFor}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {!locked && (
            <div className="mt-3">
              <AddSentence
                // One box, whatever kit the page is drawn on, so what the owner typed stays.
                key="add"
                jobId={view.id}
                kit={kitKey}
                words={words}
                first={
                  kit.kind === "email"
                    ? "The greeting: first in the email"
                    : kit.kind === "message"
                      ? "First in the message"
                      : "First in the cover note"
                }
                sentences={kit.blocks.map((block) => ({ id: block.id, text: block.text }))}
                // Before the sign-off by default: after the last sentence that is not courtesy.
                defaultAfter={
                  kit.blocks.findLast((block) => block.class !== "courtesy")?.id ??
                  kit.blocks.at(-1)?.id ??
                  ""
                }
                maxLength={MAX_SENTENCE}
                full={decisions.added.length >= MAX_ADDED}
              />
            </div>
          )}
          {kit.kind === "email" && <p className="mt-3 whitespace-pre-wrap">{kit.closing}</p>}
          {kit.kind === "message" && (
            <>
              <p className="mt-3 whitespace-pre-wrap">{kit.signOff}</p>
              <p className="mt-1 text-muted-foreground">
                {role.route.kind === "linkedin_comment"
                  ? "Your name alone: a comment is public, so your contacts stay out of it."
                  : role.route.kind === "other" || role.route.kind === "unknown"
                    ? "Your sign-off, from your profile, your contacts included: if this goes in a public comment, take them out where you post it."
                    : "Your sign-off, from your profile."}
              </p>
            </>
          )}
        </div>
        {form && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">The form&apos;s questions</p>
            <ol className="flex flex-col gap-4">
              {form.answers.map((answer) => {
                const question = questionText.get(answer.id) ?? answer.question;
                const edited = isEdited(decisions, answer.id);
                const confirmed = confirmedEdits.has(answer.id);
                const chosen = decisions.choices[answer.id];
                const built = draftedForm?.answers.find((each) => each.id === answer.id);
                return (
                  <li key={answer.id} className="flex flex-col gap-1 [overflow-wrap:anywhere]">
                    <p className="font-medium">{question}</p>
                    {answer.source === "not_answered" ? (
                      <p className="text-muted-foreground">
                        Not answered: the post wrote this question for AI tools.
                      </p>
                    ) : answer.source === "choice" && !edited ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-muted-foreground">
                          jobkit&apos;s two checks did not agree that your profile answers this.
                          Which answer goes in the form?
                        </p>
                        <p>
                          Your profile:{" "}
                          {answer.profile?.kind === "answer"
                            ? `“${answer.profile.text}”`
                            : `no answer. ${answer.profile?.reason ?? ""}`}
                        </p>
                        <p>
                          Drafted:{" "}
                          {answer.drafted
                            ? `“${answer.drafted.text}”`
                            : "no answer, so you would write your own."}
                        </p>
                        {!locked && (
                          <div className="flex flex-wrap gap-2">
                            <ActionButton
                              url={reviewUrl}
                              gateOf={view.id}
                              label="Use my profile answer"
                              ariaLabel={`Use my profile answer: ${question}`}
                              variant="outline"
                              body={decision({
                                kind: "choose",
                                questionId: answer.id,
                                use: "profile",
                                was: "",
                              })}
                            />
                            <ActionButton
                              url={reviewUrl}
                              gateOf={view.id}
                              label="Use the drafted answer"
                              ariaLabel={`Use the drafted answer: ${question}`}
                              variant="outline"
                              body={decision({
                                kind: "choose",
                                questionId: answer.id,
                                use: "drafted",
                                was: "",
                              })}
                            />
                          </div>
                        )}
                      </div>
                    ) : locked ? (
                      <p className="whitespace-pre-wrap">{answer.text}</p>
                    ) : (
                      <SentenceEdit
                        key={answer.id}
                        jobId={view.id}
                        kit={kitKey}
                        words={words}
                        blockId={answer.id}
                        text={answer.text}
                        maxLength={MAX_SENTENCE}
                        prompt={
                          answer.source === "needs_your_answer" && !answer.owner
                            ? `Needs your answer${answer.reason ? `: ${answer.reason}` : "."}`
                            : undefined
                        }
                        answer={question}
                      />
                    )}
                    {answer.source === "profile" && !answer.owner && (
                      <p className="text-muted-foreground">From your profile.</p>
                    )}
                    {answer.source === "drafted" && !answer.owner && (
                      <p className="text-muted-foreground">Drafted from your approved facts.</p>
                    )}
                    {chosen && !edited && !locked && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground">
                          You chose{" "}
                          {chosen === "profile" ? "your profile's answer" : "the drafted answer"}.
                        </span>
                        <ActionButton
                          url={reviewUrl}
                          gateOf={view.id}
                          label="Choose again"
                          ariaLabel={`Choose again: ${question}`}
                          variant="outline"
                          body={decision({
                            kind: "choose",
                            questionId: answer.id,
                            use: "",
                            was: chosen,
                          })}
                        />
                      </div>
                    )}
                    {edited && !locked && (
                      <>
                        <p className={confirmed ? "text-muted-foreground" : "font-medium"}>
                          {confirmed
                            ? "You confirmed your answer."
                            : "Your answer: confirm it says only what is true."}
                          {built?.text ? <> Drafted as: &ldquo;{built.text}&rdquo;</> : null}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {!confirmed && (
                            <ActionButton
                              url={reviewUrl}
                              gateOf={view.id}
                              label="Confirm"
                              ariaLabel={`Confirm your answer: ${question}`}
                              variant="outline"
                              body={decision({ kind: "confirm", blockId: answer.id })}
                            />
                          )}
                          <ActionButton
                            url={reviewUrl}
                            gateOf={view.id}
                            label="Undo edit"
                            ariaLabel={`Undo your answer: ${question}`}
                            variant="outline"
                            body={decision({ kind: "revert", blockId: answer.id })}
                          />
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {kit.kind === "message" && (
          <p
            className={
              messageLength(kit) > MESSAGE_LIMIT
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {messageLength(kit)} of {MESSAGE_LIMIT} characters, with your sign-off.
          </p>
        )}
      </Panel>

      {(flags.length > 0 || judged.length > 0) && (
        <Panel title="Check these before you send">
          {flags.some(
            (flag) =>
              NEEDS_NEW_WORDS.has(flag.kind) ||
              (meetable.has(flagKey(flag)) && musts.has(flag.at) && !lined.has(flag.at)),
          ) && (
            <p className="text-sm text-muted-foreground">
              {byEmail
                ? "Some of these need the email's words changed: change them above where you can, or in Gmail before you send, and then answer Yes when jobkit asks whether you changed anything."
                : "Some of these need the words changed: change them above where you can, or where you apply, before you send."}
            </p>
          )}
          <ul className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
            {judged.map((verdict) => (
              <li key={`judge-${verdict.blockId}`}>
                {judgeWords(verdict)}
                <span className="text-muted-foreground"> — {quoted(verdict.blockId)}</span>
                {!locked && (
                  <div className="mt-1 flex items-center gap-2">
                    {checked.has(verdict.blockId) ? (
                      <>
                        <span className="text-muted-foreground">You checked this.</span>
                        <ActionButton
                          url={reviewUrl}
                          gateOf={view.id}
                          label="Undo"
                          ariaLabel={`Undo: ${quoted(verdict.blockId)}`}
                          variant="outline"
                          body={decision({ kind: "uncheck", blockId: verdict.blockId })}
                        />
                      </>
                    ) : (
                      <ActionButton
                        url={reviewUrl}
                        gateOf={view.id}
                        label="I checked this"
                        ariaLabel={`I checked this: ${quoted(verdict.blockId)}`}
                        variant="outline"
                        body={decision({ kind: "check", blockId: verdict.blockId })}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
            {flags.map((flag, i) => {
              const key = flagKey(flag);
              // Two flags of one name, as two lines aimed at AI may hash alike, are two items still.
              const twin = flags.slice(0, i).filter((each) => flagKey(each) === key).length;
              const about = aboutFlag(flag);
              // A requirement only the owner can confirm: for one they do not meet, the email must
              // not claim it, so it is fixed where they send it.
              const meetsIt = meetable.has(key);
              const met = meetsIt && meets.has(meetable.get(key)!);
              // A must-have the owner does not meet needs a line saying so: theirs, written here and
              // marked as their line about it, or written where they send the email.
              const must = meetsIt && musts.has(flag.at);
              const hasLine = must && lined.has(flag.at);
              // Only new words resolve these, which Approve & send cannot give: the owner changes them
              // above, or where they send the email.
              const inGmail = NEEDS_NEW_WORDS.has(flag.kind) || (must && !hasLine);
              // A form's question the owner can answer in the form itself, as they apply.
              const inForm =
                form !== null &&
                (flag.kind === "needs_your_answer" || flag.kind === "topic_choice_needed");
              // Its place too, so two flags of one message, as on the subject and the greeting, differ.
              const named =
                about ??
                (flag.at === "subject"
                  ? `${flag.message} (the subject)`
                  : flag.at === "greeting"
                    ? `${flag.message} (the greeting)`
                    : flag.message);
              return (
                <li key={twin > 0 ? `${key}#${twin}` : key}>
                  {about ? flag.message : named}
                  {about && <span className="text-muted-foreground"> — &ldquo;{about}&rdquo;</span>}
                  {meetsIt && !met && !locked && (
                    <p className="mt-1 text-muted-foreground">
                      {flagsChecked.has(key)
                        ? hasLine
                          ? `You checked this: your line says you do not meet it, and the ${kitNoun} claims nothing more.`
                          : must
                            ? `You will fix it ${where}: take out what the ${kitNoun} says about it, and add a line saying you do not meet it.`
                            : `You checked this: the ${kitNoun} must not claim it.`
                        : hasLine
                          ? `If you meet it, tick “I meet this requirement” under How you fit. If not, make sure the ${kitNoun} claims nothing about it beyond your line, and press “I checked this”.`
                          : must
                            ? `If you meet it, tick “I meet this requirement” under How you fit. If not, take out what the ${kitNoun} says about it and add a line saying you do not meet it: above, with Add a sentence, marked as your line about it, or ${where}, pressing “I will fix it ${where}”.`
                            : `If you meet it, tick “I meet this requirement” under How you fit. If not, make sure the ${kitNoun} does not claim it, and press “I checked this”.`}
                    </p>
                  )}
                  {met ? (
                    <p className="mt-1 text-muted-foreground">
                      You said you meet it, under How you fit.
                    </p>
                  ) : (
                    !locked && (
                      <div className="mt-1 flex items-center gap-2">
                        {flagsChecked.has(key) ? (
                          <>
                            {!meetsIt && (
                              <span className="text-muted-foreground">
                                {inForm
                                  ? "You will answer it in the form."
                                  : inGmail
                                    ? `You will fix it ${where}.`
                                    : "You checked this."}
                              </span>
                            )}
                            <ActionButton
                              url={reviewUrl}
                              gateOf={view.id}
                              label="Undo"
                              ariaLabel={`Undo: ${named}`}
                              variant="outline"
                              body={decision({ kind: "uncheck_flag", flag: key })}
                            />
                          </>
                        ) : (
                          <ActionButton
                            url={reviewUrl}
                            gateOf={view.id}
                            label={
                              inForm
                                ? "I will answer it in the form"
                                : inGmail
                                  ? `I will fix it ${where}`
                                  : "I checked this"
                            }
                            ariaLabel={`${inForm ? "I will answer it in the form" : inGmail ? `I will fix it ${where}` : "I checked this"}: ${named}`}
                            variant="outline"
                            body={decision({ kind: "check_flag", flag: key })}
                          />
                        )}
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {(checklist.length > 0 || role.required_attachments.length > 0) && (
        <Panel title="What the post asks of applicants">
          {checklist.length > 0 && (
            <ul className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
              {checklist.map((item, i) => (
                <li key={`i${i}`}>
                  {item.status === "not_followed" || item.status === "not_answered" ? (
                    <>&ldquo;{withoutContacts(item.text, typing(view))}&rdquo;</>
                  ) : (
                    withoutContacts(item.text, typing(view))
                  )}
                  <span
                    className={
                      item.status === "applied"
                        ? "block text-muted-foreground"
                        : "block font-medium"
                    }
                  >
                    {CHECKLIST_WORDS[item.status]}
                  </span>
                  {/* A subject format, word limit or keyword drafting applied: the owner may decline it. */}
                  {item.decline && !locked && (
                    <div className="mt-1">
                      <ActionButton
                        url={reviewUrl}
                        gateOf={view.id}
                        label={item.status === "declined" ? "Apply it again" : "Don't apply it"}
                        ariaLabel={`${item.status === "declined" ? "Apply it again" : "Don't apply it"}: ${withoutContacts(item.text, typing(view))}`}
                        variant="outline"
                        body={decision({
                          kind: "decline",
                          instruction: item.decline,
                          declined: item.status !== "declined",
                          // As the page showed it: one changed since, elsewhere, is not undone unseen.
                          was: item.status === "declined",
                        })}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {checklist.some(
            (item) => item.status === "not_followed" || item.status === "not_answered",
          ) && (
            <p className="text-sm text-muted-foreground">
              jobkit was told not to follow the lines aimed at AI tools; the checks on the {kitNoun}{" "}
              say if it did.
            </p>
          )}
          {cv.length > 0 && (
            <p className="text-sm [overflow-wrap:anywhere]">
              Attach your CV {where}. The post asks for:{" "}
              {cv
                .map((attachment) => withoutContacts(attachment.name, typing(view)) || "a CV")
                .join("; ")}
              .
            </p>
          )}
          {parts.attachments.map((attachment) => (
            <AttachTick
              key={attachment.id}
              jobId={view.id}
              kit={kitKey}
              words={words}
              id={attachment.id}
              name={withoutContacts(attachment.name, typing(view))}
              ticked={decisions.attached.includes(attachment.id)}
              where={where}
              disabled={locked}
            />
          ))}
        </Panel>
      )}

      <Panel title="How you fit">
        {fitRows.length === 0 && (
          <p className="text-sm text-muted-foreground">The post names no requirements to weigh.</p>
        )}
        <ul className="flex flex-col gap-3 text-sm">
          {fitRows.map((row) => {
            // The facts the row cites, each once, as the profile version the draft was written with
            // holds them; the review spec shows them on any device that shows the kit.
            const cited = [...new Set(row.factIds)];
            const known = cited.filter((id) => facts.has(id));
            const met = meets.has(row.id);
            const checked = row.flag !== null && flagsChecked.has(row.flag);
            // Checked by an owner who did not say they meet it: the fit check counts it short.
            const unconfirmed = row.tick && checked && !met;
            const counted = unconfirmed && row.counted === "met" ? "partial" : row.counted;
            const requirement = withoutContacts(row.text, typing(view));
            return (
              <li key={row.id} className="border-b border-border pb-2 [overflow-wrap:anywhere]">
                <p>
                  {requirement}
                  {row.must ? "" : " (nice to have)"}
                </p>
                {counted === null ? (
                  <p className="font-medium">Not weighed</p>
                ) : (
                  <details>
                    <summary className="min-h-11 cursor-pointer py-2 font-medium">
                      {counted !== row.verdict && row.verdict !== null
                        ? `${VERDICT_WORDS[counted]}, though the draft says ${VERDICT_WORDS[row.verdict].toLowerCase()}`
                        : VERDICT_WORDS[counted]}
                      <span className="sr-only">: {requirement}</span>
                    </summary>
                    {known.length > 0 && (
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {known.map((id) => (
                          <li key={id}>{facts.get(id)}</li>
                        ))}
                      </ul>
                    )}
                    {known.length < cited.length || cited.length === 0 ? (
                      <p className="text-muted-foreground">
                        {cited.length === 0
                          ? "It cites no fact from your profile."
                          : known.length === 0
                            ? "It cites facts this profile version does not have."
                            : "It also cites facts this profile version does not have."}
                      </p>
                    ) : null}
                  </details>
                )}
                {row.note && (
                  <p className="text-muted-foreground">{withoutContacts(row.note, typing(view))}</p>
                )}
                {row.why && (
                  <p
                    className={
                      (row.tick && met) || checked ? "text-muted-foreground" : "text-destructive"
                    }
                  >
                    {row.tick && met
                      ? "You said you meet it."
                      : unconfirmed
                        ? row.must
                          ? lined.has(row.id)
                            ? `You checked this: your line says you do not meet it, and the ${kitNoun} claims nothing more.`
                            : `You will fix the ${kitNoun} ${where}: take out what it says about this, and add a line saying you do not meet it.`
                          : `You checked this: the ${kitNoun} must not claim it.`
                        : checked
                          ? `You checked this: ${row.why}`
                          : row.why}
                  </p>
                )}
                {/* A word a pick carried to a row that takes no tick here shows, to withdraw. */}
                {(row.tick || met) && (
                  <FitTick
                    jobId={view.id}
                    kit={kitKey}
                    words={words}
                    requirementId={row.id}
                    requirement={requirement}
                    ticked={met}
                    disabled={locked}
                  />
                )}
              </li>
            );
          })}
        </ul>
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
                {view.application?.status === "submitted"
                  ? "Submitted already"
                  : sent
                    ? "Sent already"
                    : skipped
                      ? "Skipped"
                      : "Before you send"}
              </p>
              <ul className="mt-1 list-disc pl-5 [overflow-wrap:anywhere]">
                {reasons.map((reason, i) => {
                  // A sentence's finding names the sentence, so two findings never read alike.
                  const flagAbout = reason.kind === "flag" ? aboutFlag(reason.flag) : undefined;
                  const about =
                    (reason.kind === "judge" || reason.kind === "unconfirmed_edit") &&
                    blockText.has(reason.blockId)
                      ? quoted(reason.blockId)
                      : flagAbout
                        ? `“${flagAbout}”`
                        : undefined;
                  // A flag on the subject or the greeting says so, as two may read alike.
                  const place =
                    reason.kind === "flag" && reason.flag.at === "subject"
                      ? " (the subject)"
                      : reason.kind === "flag" && reason.flag.at === "greeting"
                        ? " (the greeting)"
                        : "";
                  return (
                    <li key={i}>
                      {withoutContacts(reason.message, typing(view))}
                      {!about && place}
                      {about && <span className="text-muted-foreground"> — {about}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        {byEmail && kit.kind === "email" && !sent && !skipped && (
          <>
            <ApproveSend
              key={shown ? `${shown.id}-${shown.status}` : "none"}
              jobId={view.id}
              kit={kitKey}
              words={words}
              to={to}
              subject={kit.subject}
              gmail={gmail}
              onLaptop={onLaptop}
              cv={cvFile}
              approvals={approvalLines}
              approved={approved}
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
          words={view.wordsKey}
          email={byEmail}
          gmailHref={
            open && byEmail && kit.kind === "email" && to !== ""
              ? gmailComposeUrl(to, kit.subject, body, account || null)
              : null
          }
          // A message for WhatsApp opens WhatsApp on the number it goes to; LinkedIn's is copied.
          whatsApp={kit.kind === "message" && role.route.kind === "whatsapp"}
          whatsAppHref={
            open && kit.kind === "message" && role.route.kind === "whatsapp" && to !== ""
              ? whatsAppLink(to, body)
              : null
          }
          subject={kit.kind === "email" ? kit.subject : null}
          body={body}
          noun={kitNoun}
          // A form opens its https link, and copies its fields one by one or all at once.
          application={applyAt !== null}
          applicationHref={open ? applyAt : null}
          fields={
            form
              ? [
                  ...(coverNoteText(form) === ""
                    ? []
                    : [{ name: "Cover note", text: coverNoteText(form) }]),
                  ...form.answers
                    .filter((answer) => answer.text !== "")
                    .map((answer) => ({
                      name: questionText.get(answer.id) ?? answer.question,
                      text: answer.text,
                    })),
                ]
              : []
          }
        />
        {byEmail && !sent && !skipped && (
          <p className="text-sm text-muted-foreground">
            In Gmail, {account ? `check that From shows ${account}, ` : "check the From address, "}
            attach your CV, and send. Gmail adds your signature. Change the wording here rather than
            in Gmail; if you do change it in Gmail, answer Yes when jobkit asks. Attaching your CV
            does not count.
            {unmet > 0 &&
              " For each requirement you said you do not meet, take out what the email claims about it, and add a line saying so."}
          </p>
        )}
      </Panel>

      <Panel title={skipped ? "Not applying" : byEmail ? "After you send it" : "After you apply"}>
        {sent && view.application?.status === "submitted" ? (
          <div className="flex flex-col gap-2 text-sm">
            <Submitted view={view} timeZone={timeZone} canTakeBack />
          </div>
        ) : sent ? (
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
                    confirmText="Take back Mark sent? Do this only if you did not send it."
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
        ) : view.kitRoute === null ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              How do you apply for this one? The post does not say, and this kit was drafted as an
              email before jobkit asked. Your answer lets jobkit record the application once it
              goes; the kit stays as it is.
            </p>
            {!locked && (
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["email", "By email"],
                    ["form", "Through an application form"],
                    ["message", "By message"],
                  ] as const
                ).map(([route, label]) => (
                  <ActionButton
                    key={route}
                    url={`/api/jobs/${view.id}/kit-type`}
                    label={label}
                    variant="outline"
                    body={{ kit: route, since: view.stateChangedAt.toISOString() }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : open ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              Once you have applied {ROUTE_WORDS[role.route.kind]}, mark it submitted.
            </p>
            <div>
              <ActionButton
                url={`/api/jobs/${view.id}/submitted`}
                label="Mark submitted"
                body={{ kit: kitKey, to: view.handoff?.to ?? "" }}
                gateOf={view.id}
                confirmText="Did you send the application? Mark it submitted: you can take it back."
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Mark submitted appears once nothing holds the application back.
          </p>
        )}
      </Panel>

      {!sent && !parts.sending && !skipped && (
        <Panel title="Add screenshots">
          {/* More of the post, or a form's questions (intake spec, item 4). */}
          <AddScreenshots
            jobId={view.id}
            since={view.stateChangedAt.toISOString()}
            form={form !== null}
          />
        </Panel>
      )}

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

/**
 * A form or message the owner marked submitted (review spec, "Handoffs"):
 * when, with "Take back Mark submitted", by the tap it shows, on a kit the
 * page can read, which could be marked submitted again.
 */
function Submitted({
  view,
  timeZone,
  canTakeBack,
}: {
  view: JobView;
  timeZone: string;
  canTakeBack: boolean;
}) {
  const application = view.application;
  if (application?.status !== "submitted") return null;
  const at = application.submittedAt;
  return (
    <>
      <p>{at ? `Marked submitted on ${formatTime(at, timeZone)}.` : "Marked submitted."}</p>
      {at && canTakeBack && (
        <div>
          <ActionButton
            url={`/api/jobs/${view.id}/take-back`}
            label="Take back Mark submitted"
            variant="outline"
            body={{ submittedAt: at.toISOString() }}
            gateOf={view.id}
            confirmText="Take back Mark submitted? Do this only if you did not send it."
          />
        </div>
      )}
    </>
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
