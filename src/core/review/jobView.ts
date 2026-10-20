import { z } from "zod";

import { addedAnswersOf, withAddedAnswers } from "@/core/drafting/answersStage";
import { withCodeParts } from "@/core/drafting/build";
import type { DraftOutput } from "@/core/drafting/draftStage";
import { answersJudgeOf, draftJudgeOf, type JudgeOutput } from "@/core/drafting/judgeStage";
import { bodyWords } from "@/core/drafting/kit";
import type { TemplatesOutput } from "@/core/drafting/templatesStage";
import type { KitFlag } from "@/core/drafting/validate";
import { draftedAnswers } from "@/core/drafting/judge";
import { answersOf, type Kit } from "@/core/drafting/kit";
import { mustHaveCoverage, templateVerdicts, visibleRole } from "@/core/drafting/templateDrafts";
import { isBlocking, NEVER_WEIGHED } from "@/core/drafting/verdict";
import { type Agreement, agreement, type ContactKind } from "@/core/extraction/addressRead";
import { type AddressReadOutput, contactOf } from "@/core/extraction/addressReadStage";
import { isStrictAddress, normaliseWhatsAppNumber } from "@/core/extraction/contacts";
import type { EligibilityOutput } from "@/core/extraction/eligibility";
import {
  type ExtractOutput,
  readExtractOutput,
  type StopReason,
  stopReasonOf,
} from "@/core/extraction/extract";
import { chosenRole, draftedAnyway } from "@/core/extraction/owner";
import type { Role } from "@/core/extraction/record";
import { type DuplicateMatch, duplicateGate, findDuplicates } from "@/core/ledger/duplicates";
import { postFingerprint } from "@/core/ledger/normalise";
import type { ApplicationStatus, Route } from "@/core/ledger/statuses";
import { expireUploads, type Job, jobStatus } from "@/core/platform/jobs";
import { kindOf, type JobState, type StageName, type StateKind } from "@/core/platform/jobStates";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db } from "@/core/ports";
import { keptForEvaluation } from "@/core/intake/keepForEval";
import { getProfileVersion } from "@/core/profile/profile";
import { mapBox } from "@/core/shared/tileGeometry";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import type { AddressCheck } from "./addressChecks";
import type { AddressChecksOutput } from "./addressChecksStage";
import { contactForLedger, routeOf } from "./applications";
import { canHandOff, type GateReason } from "./canHandOff";
import {
  decisionsSchema,
  gateInputOf,
  type KitParts,
  NO_DECISIONS,
  type ReviewDecisions,
  withFlagNames,
} from "./decisions";
import {
  anySent,
  asShown,
  isLive,
  type KitSend,
  latestSend,
  STUCK_MS,
  uncertainSend,
  uncertainWhere,
} from "./kitSends";
import { appliedInstructions, asItStands, editedKit, wordsKey } from "./edits";
import type { ImagesWanted } from "./postImages";

/**
 * What the job page and the jobs list show (review spec, as far as the thin
 * path goes): the job's state and steps, what extract read, why it stopped,
 * the chosen role, the kit and whether it was sent. Reading a job applies
 * its upload timeout first, as every status read does (platform spec B9).
 */

export interface Step {
  stage: StageName;
  label: string;
  /**
   * "not_checked": a stage whose output is from before its check was built;
   * "skipped": Gemini's draft and its check, when the owner's templates
   * drafted the kit; "none_fit": the templates, when none fits the role;
   * "not_email": the templates, for a route whose kit is no email.
   */
  status:
    | "done"
    | "running"
    | "failed"
    | "waiting"
    | "not_checked"
    | "skipped"
    | "none_fit"
    | "not_email";
}

/** Gemini's draft among the kit's, by the name a pick gives it; a template's draft goes by its ID. */
export const GEMINI_DRAFT = "gemini";

/** One of the kit's drafts (decisions A21, with amendment A22), as the page offers it. */
export interface DraftChoice {
  /** `GEMINI_DRAFT`, or the template's ID. */
  id: string;
  /** Whose words: one of the owner's approved templates, or Gemini's, checked separately. */
  source: "template" | "gemini";
  /** The template's name; empty for Gemini's. */
  name: string;
  /** The share of the role's checkable must-haves the draft meets, as the fit check finds it. */
  coverage: number;
  /** validate's flags and the separate check's findings on it, before the owner's decisions. */
  open: number;
  words: number;
}

export interface JobView {
  id: string;
  state: JobState;
  /** When the job reached its state, which a Skip names, so a stale page's Skip is refused. */
  stateChangedAt: Date;
  kind: StateKind;
  receivedAt: Date;
  /** The job's start (intake's clock): its receipt less the time the phone held it. */
  startedAt: Date;
  failure: { stage: StageName | null; reason: string; detail: string | null } | null;
  steps: Step[];
  extraction: ExtractOutput | null;
  stopReason: StopReason | null;
  /** Whether "This is a job post" or "Read it again" is on offer. */
  canReadAgain: boolean;
  role: Role | null;
  eligibility: EligibilityOutput | null;
  /** Whether the owner chose Draft anyway. */
  draftedAnyway: boolean;
  /**
   * The kit's drafts, best first: the first is the one jobkit recommends.
   * None before the kit's first draft.
   */
  drafts: DraftChoice[];
  /** The draft the kit is: the one the owner picked, else the one jobkit recommends. */
  draft: DraftOutput | null;
  /**
   * The email or message as it stands: the draft's, with the owner's words
   * for each sentence they edited; what every handoff sends. Null with no draft.
   */
  kit: Kit | null;
  /** The kit's words as a short key, which the gate's answer names; null with no draft. */
  wordsKey: string | null;
  /** Whether the job is kept for evaluation; null for one with no image to keep. */
  keptForEval: boolean | null;
  /** Its ID among `drafts`; null when there is none. */
  picked: string | null;
  /**
   * Whether the owner can ask Gemini for a draft beside the templates': on a
   * ready kit the templates drafted, before it is sent or while it sends.
   */
  canDraftWithGemini: boolean;
  /**
   * Whether the owner can go back to the templates' drafts: when the Gemini
   * draft they asked for beside them, or its check, failed.
   */
  canGoBackToDrafts: boolean;
  /** The judge's verdicts on Gemini's draft; null before it ran, from before it was built, or with none. */
  judge: JudgeOutput | null;
  /**
   * How the contact's second read settled, and the crop it read, for the
   * page to show beside the contact (null when it made none, or read
   * another contact); null before it ran, or for a role with no contact.
   */
  contact: { kind: ContactKind; agreement: Agreement; cropPath: string | null } | null;
  /**
   * The place of the post's screenshot the contact's box lies on, which the
   * page shows first when the owner types the contact from the screenshots;
   * null when it lies on none.
   */
  contactScreenshot: number | null;
  /**
   * Whether the contact's box lies on a screenshot, its two reads agree,
   * but its second read has no crop of it to show, on a kit that has not
   * gone: the owner then types the contact from the screenshots (review
   * spec, "Contact panel"). A skipped kit keeps it, as its contact was.
   */
  noCrop: boolean;
  /**
   * Where the kit went, as the ledger records it: the address or number
   * its application keeps; null before it went, or for a kit that goes to
   * none, as a form.
   */
  wentTo: string | null;
  /** Which of the post's images the kit's page shows; null for a kit with no contact panel. */
  images: ImagesWanted | null;
  /** The email address's checks; null before they ran, or for another route. */
  addressChecks: AddressCheck[] | null;
  /**
   * The chosen role's application: its status, and when it was sent,
   * skipped, bounced or submitted, which Take back and Mark bounced name.
   */
  application: {
    status: ApplicationStatus;
    sentAt: Date | null;
    skippedAt: Date | null;
    bouncedAt: Date | null;
    submittedAt: Date | null;
  } | null;
  /**
   * The kind of kit the chosen role takes: the one its application records,
   * as the owner's pick of a kit type will set it, else its route's; null
   * while the owner must name it.
   */
  kitRoute: Route | null;
  /**
   * Whether the chosen role's kit went: the ledger says it was sent,
   * submitted or bounced, or Gmail took a send of jobkit's, though the
   * ledger may not have recorded it. The page, the jobs list and Skip read
   * it alike, whether or not the kit can still be read.
   */
  went: boolean;
  /** The ledger's matches for the application, each with whether "Apply again" covered it. */
  duplicates: (DuplicateMatch & { covered: boolean })[];
  /** What the outbound gate reads from the kit; null before there is one. */
  kitParts: KitParts | null;
  /**
   * The kit as decisions are made on it: the chosen role, the outputs of the
   * stages that read the post, and the draft picked, with the outputs that
   * made it. Decisions made on another kit, another draft included, count
   * for nothing.
   */
  kitKey: string | null;
  /**
   * The owner's decisions on the kit, and the gate's open reasons with them;
   * null until the kit is ready.
   */
  review: { decisions: ReviewDecisions; gate: GateReason[] } | null;
  /**
   * Where an email or WhatsApp kit goes: the post's contact, or the one the
   * owner typed when the kit needs one (empty until it passes); null for
   * another route, or before there is a kit.
   */
  handoff: { to: string; typed: boolean } | null;
  /**
   * The chosen role's "Approve & send" the page shows, as it now stands: the
   * one in flight, else the one Gmail took, else the latest; null when there
   * was none.
   */
  send: KitSend | null;
  /**
   * The role's latest send that may have gone, whatever came after it, for
   * the page to keep warning about until the kit is sent; null when none.
   */
  uncertain: KitSend | null;
}

/** Statuses of an application whose kit went: sent, submitted, or sent and since bounced. */
export const WENT: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  "sent",
  "submitted",
  "bounced",
]);

const NOT_CHECKED: AddressCheck = {
  kind: "not_checked",
  blocking: true,
  message: "This address has not been checked as it stands. Check it against the post.",
};

/** The stages that read the post for a kit, so a decision made on one counts for it alone. */
const POST_STAGES: readonly StageName[] = ["extract", "address_read", "address_checks"];
/** The stages that made Gemini's draft. */
const GEMINI_STAGES: readonly StageName[] = ["draft", "judge"];

/** The thin path's stages, in order. */
const STEPS: readonly { stage: StageName; label: string }[] = [
  { stage: "extract", label: "Read the post" },
  { stage: "eligibility", label: "Check eligibility" },
  { stage: "templates", label: "Draft from your templates" },
  { stage: "draft", label: "Write a draft with Gemini" },
  { stage: "judge", label: "Check every sentence separately" },
  // Shown once the owner adds a form's screenshots to the job.
  { stage: "extract_questions", label: "Read the form's new questions" },
  { stage: "draft_answers", label: "Answer the new questions" },
];

/** Steps that run only when the owner adds a form's screenshots to the job. */
const ADDED_STEPS: ReadonlySet<StageName> = new Set(["extract_questions", "draft_answers"]);

/** The stages that run beside templates and draft (B9): one that fails the job fails the step it ran beside. */
const BESIDE: ReadonlySet<StageName> = new Set(["address_read", "address_checks"]);

/**
 * What eligibility and the judge gave on the thin path before their checks
 * were built: `{ result: "not_checked" }` and `{ checked: false }`. Neither
 * says `checked: true`.
 */
interface PassedThrough {
  checked?: false;
}

export async function jobView(deps: { db: Db; clock: Clock }, id: string): Promise<JobView | null> {
  const job = await jobStatus(deps, id);
  if (!job) return null;
  const outputs = new Map<StageName, string>();
  // The judge's check of the draft itself: one of answers added since leaves the kit's key as it was.
  const draftJudge = await draftJudgeOf(deps.db, id);
  for (const stage of [...POST_STAGES, ...GEMINI_STAGES, "templates" as const]) {
    const kept = stage === "judge" ? draftJudge : await stageOutput(deps.db, id, stage);
    if (kept) outputs.set(stage, kept.outputHash);
  }
  const extract = await stageOutput(deps.db, id, "extract");
  const extraction = extract ? readExtractOutput(extract.output) : null;
  const stopReason = extraction ? stopReasonOf(extraction) : null;
  const role = await chosenRole(deps.db, id);
  // The draft with the answers added to its form since (draft_answers), and their verdicts.
  const drafted = await stageOutput(deps.db, id, "draft");
  const added = drafted ? await addedAnswersOf(deps.db, id, drafted.outputHash) : null;
  const draft = drafted
    ? withAddedAnswers(drafted.output as DraftOutput, added?.output ?? null)
    : undefined;
  const addedJudge = added ? await answersJudgeOf(deps.db, id, added.outputHash) : null;
  const ownJudge = draftJudge?.output as JudgeOutput | PassedThrough | undefined;
  const judge: JudgeOutput | PassedThrough | undefined =
    ownJudge?.checked && addedJudge
      ? { ...ownJudge, verdicts: [...ownJudge.verdicts, ...addedJudge.verdicts] }
      : ownJudge;
  const eligibility = (await stageOutput(deps.db, id, "eligibility"))?.output as
    EligibilityOutput | PassedThrough | undefined;
  const read = (await stageOutput(deps.db, id, "address_read"))?.output as
    AddressReadOutput | undefined;
  const checks = (await stageOutput(deps.db, id, "address_checks"))?.output as
    AddressChecksOutput | undefined;
  const templates = (await stageOutput(deps.db, id, "templates"))?.output as
    TemplatesOutput | undefined;
  // The drafts of the current round of drafting count, never those of an earlier one.
  const round = await draftingRound(deps.db, id);
  const geminiCurrent = round.geminiCurrent && draft !== undefined;
  const contact = contactOf(role);
  // A job that ran before a check was built keeps that output: its step shows as not checked.
  const unchecked = new Set<StageName>();
  if (eligibility && !eligibility.checked) unchecked.add("eligibility");
  if (judge && !judge.checked) unchecked.add("judge");
  // Settled against the contact as it stands now: a read made for another contact is no second
  // read of this one, and blocks it as a missing read does.
  const readThis =
    read?.checked && contact && read.kind === contact.kind && read.contact === contact.contact;
  const settled: JobView["contact"] =
    read?.checked && contact
      ? {
          kind: contact.kind,
          agreement: readThis
            ? agreement(contact.kind, contact.contact, read.second)
            : { ok: false, reason: "no_second_read" },
          cropPath: readThis ? (read.cropPath ?? null) : null,
        }
      : null;
  const addressChecks =
    contact?.kind === "email" ? addressChecksOf(contact.contact, checks, read) : null;
  const ready = job.state === "kit_ready";
  const application = role ? await applicationOf(deps.db, id, role.id) : null;
  // As kitRouteOf decides, so the page offers what Mark sent and Mark submitted accept.
  const kitRoute = application ? application.route : role ? routeOf(role.route.kind) : null;
  const picked = role ? await pickedDraftOf(deps.db, id, role.id) : null;
  const candidates =
    role && extraction
      ? await candidatesOf(deps.db, {
          role,
          visible: visibleRole(extraction.record, role),
          outputs,
          templates: round.templatesCurrent ? templates : undefined,
          gemini: geminiCurrent ? draft! : null,
          judge,
          emailKit: (kitRoute ?? "email") === "email",
          picked,
        })
      : [];
  const chosen =
    candidates.find((candidate) => candidate.choice.id === picked) ?? candidates[0] ?? null;
  const hasKit = Boolean(chosen && role && extraction);
  const kitKey = hasKit ? chosen!.kitKey : null;
  const decisions =
    kitKey && role ? await decisionsOf(deps.db, id, role.id, kitKey, chosen!.draft.flags) : null;
  // The email as it stands, with the owner's edits, the sentences they added and none they deleted,
  // and the instructions they declined; validate runs again on a changed one (drafting spec, "Owner
  // edits"), and an unchanged one keeps drafting's flags.
  const owners = decisions ?? NO_DECISIONS;
  const standing =
    chosen && role && extraction
      ? await asItStands(deps.db, {
          draft: chosen.draft,
          record: extraction.record,
          role,
          template: chosen.choice.source === "template",
          decisions: owners,
        })
      : null;
  const kit = standing?.kit ?? (chosen ? editedKit(chosen.draft.kit, owners) : null);
  const flags = standing?.flags ?? chosen?.draft.flags ?? [];
  const latest = role ? await latestSend(deps.db, id, role.id) : null;
  const now = deps.clock.now();
  const sentByJobkit = role ? await anySent(deps.db, id, role.id) : false;
  // jobkit sent it, though the ledger may not have recorded it: it went.
  const went = Boolean(application && WENT.has(application.status)) || sentByJobkit;
  // The screenshot the contact's box lies on, from the post's reading, which a purge leaves.
  const contactScreenshot =
    role && extraction ? (mapBox(role.route.box, extraction.tiles)?.image ?? null) : null;
  // A contact read from a screenshot shows its crop beside it; with none to show, the owner types
  // it from the screenshots, however the reads settled (review spec, "Contact panel"). One settled
  // from the pasted text, its box on no screenshot, was read as written. A kit that went shows
  // where it went, as the ledger keeps it.
  const noCrop =
    !went &&
    contactScreenshot !== null &&
    settled?.agreement.ok === true &&
    settled.cropPath === null;
  // An address or number the owner typed stands once it passes, even where the kit would no
  // longer ask for one, as after an update that reads the post's as agreed: never the post's.
  // An email the owner picked for a post that does not say how to apply goes to an address it
  // does not give: the owner types it, as for an email post with none.
  const contactRole =
    role && kitRoute === "email" && role.route.kind !== "email" && role.route.kind !== "whatsapp"
      ? { ...role, route: { ...role.route, kind: "email" as const, address: "" } }
      : role;
  const needsRetype = contactRole
    ? needsRetypeOf(contactRole, settled, addressChecks, noCrop) ||
      typedPasses(contactRole, decisions ?? NO_DECISIONS)
    : false;
  const handoff =
    hasKit && contactRole ? handoffOf(contactRole, needsRetype, decisions ?? NO_DECISIONS) : null;
  // A kit that ran before its application opened with it is weighed against every earlier one
  // too, at the address it goes to.
  const duplicates = application
    ? await kitDuplicatesOf(deps.db, application.id)
    : ready && contactRole && extraction
      ? await unopenedDuplicates(deps.db, contactRole, extraction, handoff)
      : [];
  const kitParts =
    chosen && role && extraction
      ? kitPartsOf({
          draft: { ...chosen.draft, flags },
          added: owners.added.map((sentence) => sentence.id),
          // The must-haves a line in the owner's words answers in the email as it stands.
          ownLines: (kit?.blocks ?? []).flatMap((block) => (block.owner ? answersOf(block) : [])),
          verdicts: verdictsAsItStands(kit, chosen.verdicts),
          role,
          contactKind: contactKindOf(contactRole!),
          extraction,
          needsRetype,
          addressChecks,
          duplicates,
          sent: went,
          byEmail: kitRoute === "email",
          sending: latest !== null && isLive(latest, now),
          skipped: application?.status === "skipped",
          submitted: application?.status === "submitted",
        })
      : null;
  return {
    id,
    state: job.state,
    stateChangedAt: job.stateChangedAt,
    kind: kindOf(job.state),
    receivedAt: job.receivedAt,
    startedAt: new Date(job.receivedAt.getTime() - job.clientElapsedMs),
    failure: await failureOf(deps.db, job),
    steps: await stepsOf(deps.db, job, unchecked, {
      drafted: round.templatesCurrent && (templates?.drafts.length ?? 0) > 0,
      noneFit: (templates?.drafts.length ?? 0) === 0,
      notEmail: (kitRoute ?? "email") !== "email",
      geminiCurrent,
      askedGemini: round.askedGemini,
    }),
    extraction,
    stopReason,
    canReadAgain:
      job.state === "stopped" &&
      (stopReason === "not_a_job_post" || stopReason === "no_role") &&
      !extraction!.postConfirmed,
    role,
    eligibility: eligibility?.checked ? eligibility : null,
    draftedAnyway: await draftedAnyway(deps.db, id),
    drafts: candidates.map((candidate) => candidate.choice),
    draft: chosen?.draft ?? null,
    kit,
    wordsKey: kit ? wordsKey(kit) : null,
    keptForEval: await keptForEvaluation(deps.db, id),
    picked: chosen?.choice.id ?? null,
    canDraftWithGemini:
      ready &&
      candidates.length > 0 &&
      !candidates.some((candidate) => candidate.choice.source === "gemini") &&
      kitParts !== null &&
      !kitParts.sent &&
      !kitParts.sending &&
      !kitParts.skipped,
    canGoBackToDrafts:
      job.state === "failed" &&
      (job.pendingStage === "draft" || job.pendingStage === "judge") &&
      candidates.some((candidate) => candidate.choice.source === "template"),
    judge: geminiCurrent && judge?.checked ? judge : null,
    contact: settled,
    contactScreenshot,
    noCrop,
    wentTo: went ? (application?.address ?? null) : null,
    // The screenshots while the owner types the contact from them, or checks a bounced one against
    // the post; in place of a crop that cannot be shown; none once the kit went, or where no crop
    // could be, as for a contact the pasted text settled.
    images:
      ready && kitKey && kitParts?.contact
        ? {
            cropPath: settled?.cropPath ?? null,
            screenshots:
              application?.status === "bounced"
                ? "always"
                : went
                  ? "never"
                  : needsRetype
                    ? "always"
                    : contactScreenshot !== null
                      ? "without-crop"
                      : "never",
            first: contactScreenshot,
          }
        : null,
    addressChecks,
    application: application && {
      status: application.status,
      sentAt: application.sentAt,
      skippedAt: application.skippedAt,
      bouncedAt: application.bouncedAt,
      submittedAt: application.submittedAt,
    },
    kitRoute,
    went,
    duplicates,
    kitParts,
    kitKey,
    review:
      ready && kitParts && decisions
        ? { decisions, gate: canHandOff(gateInputOf(kitParts, decisions)) }
        : null,
    handoff,
    send: latest && asShown(latest, now),
    uncertain: role ? await uncertainSend(deps.db, id, role.id, now) : null,
  };
}

/** A draft of the kit's, with what the gate and the page read of it. */
interface Candidate {
  choice: DraftChoice;
  draft: DraftOutput;
  verdicts: KitParts["verdicts"];
  kitKey: string;
}

/**
 * The kit's drafts, best first: the templates' for the chosen role, and
 * Gemini's when it was written in the current round of drafting. A
 * template draft's key names the template; Gemini's is the kit's key as it
 * was before the templates, so decisions made on such a kit still count.
 */
async function candidatesOf(
  db: Db,
  kit: {
    role: Role;
    /** The role as the drafting call sees it, which coverage weighs. */
    visible: Role;
    outputs: ReadonlyMap<StageName, string>;
    /** The templates' output in the current round of drafting; none from an earlier one. */
    templates: TemplatesOutput | undefined;
    /** Gemini's draft, written and judged in the current round; null otherwise. */
    gemini: DraftOutput | null;
    judge: JudgeOutput | PassedThrough | undefined;
    /** Whether the job takes an email's kit, which alone the templates draft. */
    emailKit: boolean;
    /** The draft the owner picked, if they did. */
    picked: string | null;
  },
): Promise<Candidate[]> {
  const { role, outputs, templates, gemini, judge } = kit;
  const of = (stages: readonly StageName[]) =>
    Object.fromEntries([...outputs].filter(([stage]) => stages.includes(stage)));
  const candidates: Candidate[] = [];
  for (const draft of templates?.drafts ?? []) {
    if (draft.roleId !== role.id) continue;
    // Templates draft emails alone now. One a message's or a form's job kept from before (when
    // templates drafted for every route) stays its kit while Gemini has drafted none, and while the
    // owner keeps it picked: it is what they reviewed, and may be what went.
    if (!kit.emailKit && gemini?.roleId === role.id && kit.picked !== draft.templateId) continue;
    const verdicts = templateVerdicts(draft.kit);
    candidates.push({
      choice: choiceOf(draft, verdicts, {
        id: draft.templateId,
        source: "template",
        name: draft.templateName,
        coverage: draft.coverage,
      }),
      draft,
      verdicts,
      kitKey: sha256Hex(
        canonicalJson({
          role: role.id,
          outputs: of([...POST_STAGES, "templates"]),
          template: draft.templateId,
        }),
      ),
    });
  }
  if (gemini && gemini.roleId === role.id) {
    const profile = await getProfileVersion(db, gemini.profileVersion);
    const verdicts = verdictsOf(gemini, judge);
    // The parts code builds from the profile, as the code builds them now.
    const draft: DraftOutput = profile
      ? {
          ...gemini,
          kit: withCodeParts(gemini.kit, {
            route: role.route.kind,
            owner: profile.owner.name,
            topics: { home: profile.owner.location.country, answers: profile.fixedAnswers },
          }),
        }
      : gemini;
    candidates.push({
      choice: choiceOf(draft, verdicts, {
        id: GEMINI_DRAFT,
        source: "gemini",
        name: "",
        coverage: profile ? mustHaveCoverage(kit.visible, gemini.fit, profile.facts) : 0,
      }),
      draft,
      verdicts,
      kitKey: sha256Hex(
        canonicalJson({ role: role.id, outputs: of([...POST_STAGES, ...GEMINI_STAGES]) }),
      ),
    });
  }
  return ranked(candidates);
}

function choiceOf(
  draft: DraftOutput,
  verdicts: KitParts["verdicts"],
  about: Pick<DraftChoice, "id" | "source" | "name" | "coverage">,
): DraftChoice {
  return {
    ...about,
    open: draft.flags.length + verdicts.filter(isBlocking).length,
    words: bodyWords(draft.kit),
  };
}

/**
 * The drafts best first (decisions A21): the most of the role's must-haves
 * met, then the fewest flags and findings to check, then the shortest; a
 * template's before Gemini's when nothing else tells them apart.
 */
function ranked(candidates: Candidate[]): Candidate[] {
  return candidates
    .map((candidate, place) => ({ candidate, place }))
    .sort(
      (a, b) =>
        b.candidate.choice.coverage - a.candidate.choice.coverage ||
        a.candidate.choice.open - b.candidate.choice.open ||
        a.candidate.choice.words - b.candidate.choice.words ||
        a.place - b.place,
    )
    .map(({ candidate }) => candidate);
}

/** The draft the owner picked for the role's kit; null before they pick one. */
async function pickedDraftOf(db: Db, jobId: string, roleId: string): Promise<string | null> {
  const { rows } = await db.query<{ picked_draft: string | null }>(
    "select picked_draft from {{schema}}.kit_reviews where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  return rows[0]?.picked_draft ?? null;
}

/**
 * Where the job's current round of drafting stands. A round starts as the
 * post is read or eligibility runs, whichever came last, then the templates; Gemini's draft is current when it
 * was written after the templates last ran (or in a job from before them)
 * and judged after that, so a draft from an earlier reading of the post, or
 * one whose check failed, is never offered. `askedGemini`: the owner asked
 * for a Gemini draft beside the templates' in this round, whatever came of it.
 */
async function draftingRound(
  db: Db,
  jobId: string,
): Promise<{ geminiCurrent: boolean; templatesCurrent: boolean; askedGemini: boolean }> {
  const { rows } = await db.query<{
    gemini_current: boolean;
    templates_current: boolean;
    asked_gemini: boolean;
  }>(
    `with latest as (
       select stage, max(id) as id from {{schema}}.job_stage_runs
        where job_id = $1 and outcome in ('ok', 'reused') group by stage
     ), at as (
       select coalesce((select id from latest where stage = 'templates'), 0) as templates,
              greatest(coalesce((select id from latest where stage = 'eligibility'), 0),
                       coalesce((select id from latest where stage = 'extract'), 0)) as started,
              coalesce((select id from latest where stage = 'draft'), 0) as draft,
              coalesce((select id from latest where stage = 'judge'), 0) as judge
     )
     select at.draft > at.templates and at.judge > at.draft and at.draft > at.started
              as gemini_current,
            at.templates > at.started as templates_current,
            at.templates > 0 and exists (
              select 1 from {{schema}}.job_stage_runs as run
               where run.job_id = $1 and run.stage in ('draft', 'judge') and run.id > at.templates
            ) as asked_gemini
       from at`,
    [jobId],
  );
  const row = rows[0];
  return {
    geminiCurrent: row?.gemini_current === true,
    templatesCurrent: row?.templates_current === true,
    askedGemini: row?.asked_gemini === true,
  };
}

/**
 * The judge's verdict on each of the kit's sentences. One the separate
 * check never weighed, in a kit from before it was built or with no
 * verdict of its own, counts as unsupported (drafting spec).
 */
function verdictsOf(
  draft: DraftOutput,
  judge: JudgeOutput | PassedThrough | undefined,
): KitParts["verdicts"] {
  const given = judge?.checked ? judge.verdicts : [];
  // A form's answers the drafter wrote are weighed too, as sentences are.
  const weighed = [...draft.kit.blocks, ...draftedAnswers(draft.kit)];
  return weighed.map(
    (block) =>
      given.find((verdict) => verdict.blockId === block.id) ?? {
        blockId: block.id,
        verdict: "unsupported" as const,
        companyClaim: false,
        note: NEVER_WEIGHED,
      },
  );
}

/**
 * Whether the owner must type an email or WhatsApp contact in place of the
 * post's: when the post gave none, when it fails the strict check, when its
 * second read did not agree or never ran, when one of its address's checks
 * holds it, or when it was read from a screenshot but has no crop of it to
 * show. The address the owner types is checked on its own.
 */
function needsRetypeOf(
  role: Role,
  settled: JobView["contact"],
  addressChecks: AddressCheck[] | null,
  noCrop: boolean,
): boolean {
  const { kind, address } = role.route;
  if (kind !== "email" && kind !== "whatsapp") return false;
  const given = address.trim();
  const passes = kind === "email" ? isStrictAddress(given) : normaliseWhatsAppNumber(given).ok;
  const held = (addressChecks ?? []).some((check) => check.blocking);
  return given === "" || !passes || settled?.agreement.ok !== true || held || noCrop;
}

/** Whether the owner typed an email address or number for the role that passes the strict check. */
function typedPasses(role: Role, decisions: ReviewDecisions): boolean {
  const { kind } = role.route;
  const typed = decisions.retyped?.value ?? "";
  if (typed === "") return false;
  if (kind === "email") return isStrictAddress(typed);
  return kind === "whatsapp" && normaliseWhatsAppNumber(typed).ok;
}

/**
 * Where the kit goes: the post's contact, unless the kit needs the owner to
 * type one; then what they typed, once it passes the strict check.
 */
function handoffOf(
  role: Role,
  needsRetype: boolean,
  decisions: ReviewDecisions,
): JobView["handoff"] {
  const { kind, address } = role.route;
  if (kind !== "email" && kind !== "whatsapp") return null;
  if (!needsRetype) return { to: address.trim(), typed: false };
  return { to: typedPasses(role, decisions) ? decisions.retyped!.value : "", typed: true };
}

/** The kind of contact a role's route gives, an email or a WhatsApp number; none for another. */
function contactKindOf(role: Role): "email" | "whatsapp" | null {
  const { kind } = role.route;
  return kind === "email" || kind === "whatsapp" ? kind : null;
}

/**
 * The matches of a kit with no application yet, from what extract read and
 * the address it goes to, the owner's typed one included; none is covered.
 */
async function unopenedDuplicates(
  db: Db,
  role: Role,
  extraction: ExtractOutput,
  handoff: JobView["handoff"],
): Promise<JobView["duplicates"]> {
  const to = handoff?.typed && handoff.to !== "" ? handoff.to : role.route.address;
  const matches = await findDuplicates(db, {
    company: extraction.record.company.name,
    role: role.title,
    address: contactForLedger(role.route.kind, to),
    fingerprint: postFingerprint(role.requirements.map((requirement) => requirement.text)),
  });
  return matches.map((match) => ({ ...match, covered: false }));
}

/** What the gate reads from a kit. The CV needs no tick: the page says to attach it in Gmail. */
function kitPartsOf(parts: {
  draft: DraftOutput;
  /** The sentences the owner added, by ID. */
  added: readonly string[];
  ownLines: string[];
  verdicts: KitParts["verdicts"];
  role: Role;
  /** The kind of contact the kit goes to, the owner's typed address for an email they picked. */
  contactKind: "email" | "whatsapp" | null;
  extraction: ExtractOutput;
  needsRetype: boolean;
  addressChecks: AddressCheck[] | null;
  duplicates: JobView["duplicates"];
  sent: boolean;
  byEmail: boolean;
  submitted: boolean;
  sending: boolean;
  skipped: boolean;
}): KitParts {
  // A form's answers but those never given, which the owner types or checks like sentences.
  const answers =
    parts.draft.kit.kind === "form"
      ? parts.draft.kit.answers.filter((answer) => answer.source !== "not_answered")
      : [];
  return {
    blocks: [
      ...parts.draft.kit.blocks.map((block) => block.id),
      ...parts.added,
      ...answers.map((answer) => answer.id),
    ],
    answers: answers.map((answer) => answer.id),
    choices: answers.filter((answer) => answer.source === "choice").map((answer) => answer.id),
    applied: appliedInstructions(parts.draft, parts.role),
    ownLines: parts.ownLines,
    flags: parts.draft.flags,
    verdicts: parts.verdicts,
    attachments: parts.role.required_attachments.flatMap((attachment, i) =>
      attachment.is_cv ? [] : [{ id: `A${i + 1}`, name: attachment.name }],
    ),
    contact: parts.contactKind && { kind: parts.contactKind, needsRetype: parts.needsRetype },
    addressChecks: parts.addressChecks ?? [],
    scamSignals: [...parts.extraction.record.scam_signals, ...parts.extraction.backstop].map(
      (signal) => signal.quote || signal.kind,
    ),
    duplicates: duplicateParts(parts.duplicates),
    sent: parts.sent,
    byEmail: parts.byEmail,
    submitted: parts.submitted,
    sending: parts.sending,
    skipped: parts.skipped,
    mustHaves: parts.role.requirements
      .filter((requirement) => requirement.priority === "must")
      .map((requirement) => requirement.id),
  };
}

/**
 * The separate check's verdicts on the kit as it stands: a form's answer
 * keeps its verdict only while it is the drafted one, as when the owner
 * chose it, never once the profile's or the owner's words stand instead.
 */
function verdictsAsItStands(kit: Kit | null, verdicts: KitParts["verdicts"]): KitParts["verdicts"] {
  if (kit?.kind !== "form") return verdicts;
  const answers = new Map(kit.answers.map((answer) => [answer.id, answer]));
  return verdicts.filter((verdict) => {
    const answer = answers.get(verdict.blockId);
    return !answer || (answer.source === "drafted" && !answer.owner);
  });
}

/** The decisions as kit_reviews keeps them: with the kit they were made on. */
const storedDecisionsSchema = decisionsSchema.extend({ kit: z.string() });

/**
 * The owner's decisions on a job's kit for a role, kept in kit_reviews:
 * none before the first, and none when they were made on another kit, or
 * cannot be read, so every reason they cleared holds again.
 */
export async function decisionsOf(
  db: Db,
  jobId: string,
  roleId: string,
  kitKey: string,
  flags: readonly KitFlag[],
): Promise<ReviewDecisions> {
  const { rows } = await db.query<{ decisions: unknown; draft_checks: unknown }>(
    "select decisions, draft_checks from {{schema}}.kit_reviews where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  const parsed = storedDecisionsSchema.safeParse(rows[0]?.decisions);
  if (parsed.success && parsed.data.kit === kitKey) {
    // The decisions alone, without the kit they name.
    return withFlagNames(decisionsSchema.parse(parsed.data), flags);
  }
  // A draft the owner moved away from keeps its sentence and flag decisions aside, by its key, as
  // when the page falls back to it: those count again (draftChoice.ts).
  const aside = draftChecksSchema.safeParse(rows[0]?.draft_checks);
  const kept = aside.success ? aside.data[kitKey] : undefined;
  return kept ? withFlagNames({ ...NO_DECISIONS, ...kept }, flags) : NO_DECISIONS;
}

/** Each draft's sentence and flag decisions, kept aside by its kit key while another is the kit. */
export const draftChecksSchema = z.record(
  z.string(),
  z.object({
    checked: z.array(z.string()),
    flagsChecked: z.array(z.string()),
    // Kept from before the block editor: none.
    edits: z.record(z.string(), z.string()).default({}),
    confirmed: z.array(z.string()).default([]),
    // Kept from before sentences could be added or deleted: none.
    added: z.array(z.object({ id: z.string(), after: z.string(), text: z.string() })).default([]),
    deleted: z.array(z.string()).default([]),
    answers: z.record(z.string(), z.string()).default({}),
  }),
);
export type DraftChecks = z.infer<typeof draftChecksSchema>;

/** The decisions as kit_reviews keeps them. */
export function storedDecisions(kitKey: string, decisions: ReviewDecisions): string {
  return JSON.stringify({ kit: kitKey, ...decisions });
}

/**
 * The checks of the address as it stands. Checks for another address, or
 * none once the drafting group ran, block as not checked; so do checks that
 * stopped at an older, stricter rule's strict check the address now passes,
 * since the checks after it never ran.
 */
function addressChecksOf(
  contact: string,
  checks: AddressChecksOutput | undefined,
  read: AddressReadOutput | undefined,
): AddressCheck[] | null {
  const address = contact.trim();
  const current =
    checks?.checked &&
    checks.address === address &&
    !(checks.checks.some((check) => check.kind === "syntax") && isStrictAddress(address));
  if (current) return checks.checks;
  return read?.checked ? [NOT_CHECKED] : null;
}

async function failureOf(db: Db, job: Job): Promise<JobView["failure"]> {
  if (job.state !== "failed") return null;
  // The failed stage's last recorded error in this round: technical words, shown only under "Details".
  const { rows } = await db.query<{ error: string | null }>(
    `select error from {{schema}}.job_stage_runs
      where job_id = $1 and stage = $2 and round = $3 and outcome = 'failed'
      order by id desc limit 1`,
    [job.id, job.failedStage ?? job.pendingStage, job.retryRound],
  );
  const detail = rows[0]?.error ?? null;
  return {
    stage: job.failedStage,
    reason: job.failure ?? "This step failed.",
    detail: detail === job.failure ? null : detail,
  };
}

async function stepsOf(
  db: Db,
  job: Job,
  unchecked: ReadonlySet<StageName>,
  drafting: {
    /** The templates drafted the kit in the current round. */
    drafted: boolean;
    /** The templates' latest run drafted nothing. */
    noneFit: boolean;
    /** The chosen role's route takes a message or a form, which the templates never draft. */
    notEmail: boolean;
    geminiCurrent: boolean;
    askedGemini: boolean;
  },
): Promise<Step[]> {
  const { rows } = await db.query<{ stage: StageName; outcome: string }>(
    `select distinct on (stage) stage, outcome from {{schema}}.job_stage_runs
      where job_id = $1 order by stage, id desc`,
    [job.id],
  );
  const last = new Map(rows.map((row) => [row.stage, row.outcome]));
  // A failed job keeps the stage pending it failed at: the one a stage beside it ran with.
  const failedStep =
    job.failedStage && BESIDE.has(job.failedStage) ? job.pendingStage : job.failedStage;
  // The templates drafted the kit, and Gemini's draft is not among its drafts, nor being written.
  const fromTemplates =
    drafting.drafted &&
    !drafting.geminiCurrent &&
    job.pendingStage !== "draft" &&
    job.pendingStage !== "judge";
  return (
    STEPS
      // A job drafted before the templates were built shows the steps it ran.
      .filter(({ stage }) => stage !== "templates" || last.has("templates") || !last.has("draft"))
      .filter(
        ({ stage }) => !ADDED_STEPS.has(stage) || last.has(stage) || job.pendingStage === stage,
      )
      .map(({ stage, label }) => {
        const outcome = last.get(stage);
        let status: Step["status"] = "waiting";
        // A stage running again, as after "Read it again", is running, whatever it gave before.
        if (job.state === "failed" && failedStep === stage) status = "failed";
        else if (kindOf(job.state) === "running" && job.pendingStage === stage) status = "running";
        else if ((stage === "draft" || stage === "judge") && fromTemplates) {
          // Asked for and come to nothing, as when its check failed, it shows how it ended.
          status = !drafting.askedGemini
            ? "skipped"
            : outcome === "ok" || outcome === "reused"
              ? "done"
              : outcome === "failed" || outcome === "abandoned"
                ? "failed"
                : "waiting";
        } else if (outcome === "ok" || outcome === "reused") {
          if (stage === "templates") {
            // Drafts a message's or a form's job kept from before templates drafted emails alone
            // were drafted all the same.
            status = !drafting.noneFit ? "done" : drafting.notEmail ? "not_email" : "none_fit";
          } else status = unchecked.has(stage) ? "not_checked" : "done";
        }
        return { stage, label, status };
      })
  );
}

async function applicationOf(
  db: Db,
  jobId: string,
  roleId: string,
): Promise<{
  id: string;
  status: ApplicationStatus;
  sentAt: Date | null;
  skippedAt: Date | null;
  bouncedAt: Date | null;
  submittedAt: Date | null;
  route: Route | null;
  address: string | null;
} | null> {
  const { rows } = await db.query<{
    id: string;
    status: ApplicationStatus;
    sent_at: Date | null;
    skipped_at: Date | null;
    bounced_at: Date | null;
    submitted_at: Date | null;
    route: Route | null;
    address: string | null;
  }>(
    `select id, status, sent_at, skipped_at, bounced_at, submitted_at, route, address
       from {{schema}}.applications
      where job_id = $1 and role_id = $2`,
    [jobId, roleId],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        sentAt: row.sent_at,
        skippedAt: row.skipped_at,
        bouncedAt: row.bounced_at,
        submittedAt: row.submitted_at,
        route: row.route,
        address: row.address,
      }
    : null;
}

/** The application's duplicate matches, each with whether "Apply again" covered it. */
export async function kitDuplicatesOf(
  db: Db,
  applicationId: string,
): Promise<JobView["duplicates"]> {
  const gate = await duplicateGate(db, applicationId);
  if (!gate) return [];
  const covered = new Set(gate.covers);
  return gate.matches.map((match) => ({ ...match, covered: covered.has(match.key) }));
}

/** The matches as the gate reads them. */
export function duplicateParts(matches: JobView["duplicates"]): KitParts["duplicates"] {
  return matches.map((match) => ({ reason: duplicateWords(match), covered: match.covered }));
}

/**
 * A duplicate match as the gate names it: what matched, and the earlier
 * application. The banner above gives its day, in the owner's time zone.
 */
function duplicateWords(match: DuplicateMatch): string {
  const earlier = `${match.company || "a company it did not name"}, ${match.role || "a role it did not name"}`;
  switch (match.reason) {
    case "company-role":
      return `the same company and role as ${earlier}`;
    case "address":
      return `the same address as ${earlier}`;
    case "post":
      return `a post much like ${earlier}`;
    case "drafted":
      return `a kit already drafted for ${earlier}`;
  }
}

export interface JobListItem {
  id: string;
  state: JobState;
  kind: StateKind;
  receivedAt: Date;
  company: string;
  title: string;
  /** How the chosen role applies; null before a role is chosen. */
  route: Role["route"]["kind"] | null;
  /** When the job reached its state, which a Skip from the list names. */
  stateChangedAt: Date;
  /** Why a failed job failed, in the words its page shows; null for any other. */
  failure: string | null;
  /**
   * Whether a failed job can go back to the templates' drafts, as when a
   * Gemini draft asked for beside them failed: its Skip waits for its page,
   * which offers that first.
   */
  backToDrafts: boolean;
  /**
   * Whether a send of a failed job's kit may have gone, as when a Gemini
   * draft asked for beside the kit failed: its Skip waits for its page,
   * which warns of the send.
   */
  uncertain: boolean;
  /**
   * Whether the chosen role's kit went, as the job page says: sent, submitted
   * or bounced in the ledger, or taken by Gmail from jobkit.
   */
  sent: boolean;
  /** Whether the owner marked the chosen role's sent email bounced, as the job page says. */
  bounced: boolean;
  /** Whether the owner marked the chosen role's form or message submitted, as the job page says. */
  submitted: boolean;
  /**
   * Whether the owner skipped the chosen role's ready kit, which stays ready to take the skip
   * back; a job a skip closed reads as closed, as its page does.
   */
  skipped: boolean;
}

/**
 * The jobs list, newest first, with what extract read of each post. Reading
 * it applies the upload timeout first, as every status read does (B9).
 */
export async function listJobViews(
  deps: { db: Db; clock: Clock },
  limit = 50,
): Promise<JobListItem[]> {
  const { db } = deps;
  await expireUploads(db, deps.clock.now());
  const { rows } = await db.query<{
    id: string;
    state: JobState;
    received_at: Date;
    chosen_role: string | null;
    chosen_role_output: string | null;
    failure: string | null;
    state_changed_at: Date;
    pending_stage: string | null;
    uncertain_roles: string[];
    template_drafts: boolean;
    output: unknown;
    output_hash: string | null;
    sent_roles: string[];
    skipped_roles: string[];
    bounced_roles: string[];
    submitted_roles: string[];
  }>(
    `select j.id, j.state, j.state_changed_at, j.pending_stage, j.received_at, j.chosen_role,
            j.chosen_role_output, j.failure, x.output, x.output_hash,
            array(select a.role_id from {{schema}}.applications as a
                   where a.job_id = j.id and a.status in ('sent', 'submitted', 'bounced')
                  union
                  select k.role_id from {{schema}}.kit_sends as k
                   where k.job_id = j.id and k.status = 'sent') as sent_roles,
            array(select a.role_id from {{schema}}.applications as a
                   where a.job_id = j.id and a.status = 'skipped') as skipped_roles,
            array(select a.role_id from {{schema}}.applications as a
                   where a.job_id = j.id and a.status = 'bounced') as bounced_roles,
            array(select a.role_id from {{schema}}.applications as a
                   where a.job_id = j.id and a.status = 'submitted') as submitted_roles,
            array(select k.role_id from {{schema}}.kit_sends as k
                   where k.job_id = j.id and ${uncertainWhere("$2")}) as uncertain_roles,
            coalesce((select case jsonb_typeof(t.output -> 'drafts')
                               when 'array' then jsonb_array_length(t.output -> 'drafts') > 0
                               else false
                             end
                        from {{schema}}.job_stage_runs as t
                       where t.job_id = j.id and t.stage = 'templates'
                         and t.outcome in ('ok', 'reused')
                       order by t.id desc limit 1), false) as template_drafts
       from {{schema}}.jobs as j
       left join lateral (
         select output, output_hash from {{schema}}.job_stage_runs as r
          where r.job_id = j.id and r.stage = 'extract' and r.outcome in ('ok', 'reused')
          order by r.id desc limit 1
       ) as x on true
      order by j.received_at desc
      limit $1`,
    // A send left sending this long before now may have gone, as `uncertainSend` reads it.
    [limit, new Date(deps.clock.now().getTime() - STUCK_MS)],
  );
  return rows.map((row): JobListItem => {
    const extraction = readExtractOutput(row.output);
    const roles = extraction?.record.roles ?? [];
    const picked =
      row.chosen_role !== null && row.chosen_role_output === row.output_hash
        ? roles.find((role) => role.id === row.chosen_role)
        : undefined;
    const role = picked ?? (roles.length === 1 ? roles[0] : undefined);
    return {
      id: row.id,
      state: row.state,
      kind: kindOf(row.state),
      receivedAt: row.received_at,
      company: extraction?.record.company.name ?? "",
      title: role?.title ?? (roles.length > 1 ? `${roles.length} roles` : ""),
      stateChangedAt: row.state_changed_at,
      route: role?.route.kind ?? null,
      failure: row.state === "failed" ? (row.failure ?? "This step failed.") : null,
      uncertain:
        row.state === "failed" && role !== undefined && row.uncertain_roles.includes(role.id),
      backToDrafts:
        row.state === "failed" &&
        (row.pending_stage === "draft" || row.pending_stage === "judge") &&
        row.template_drafts,
      sent: role !== undefined && row.sent_roles.includes(role.id),
      bounced: role !== undefined && row.bounced_roles.includes(role.id),
      submitted: role !== undefined && row.submitted_roles.includes(role.id),
      skipped:
        row.state === "kit_ready" &&
        role !== undefined &&
        row.skipped_roles.includes(role.id) &&
        !row.sent_roles.includes(role.id),
    };
  });
}
