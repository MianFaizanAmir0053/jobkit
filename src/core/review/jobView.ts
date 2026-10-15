import { z } from "zod";

import type { DraftOutput } from "@/core/drafting/draftStage";
import type { JudgeOutput } from "@/core/drafting/judgeStage";
import { bodyWords } from "@/core/drafting/kit";
import type { TemplatesOutput } from "@/core/drafting/templatesStage";
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
import type { ApplicationStatus } from "@/core/ledger/statuses";
import { expireUploads, type Job, jobStatus } from "@/core/platform/jobs";
import { kindOf, type JobState, type StageName, type StateKind } from "@/core/platform/jobStates";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import type { AddressCheck } from "./addressChecks";
import type { AddressChecksOutput } from "./addressChecksStage";
import { contactForLedger } from "./applications";
import { canHandOff, type GateReason } from "./canHandOff";
import {
  decisionsSchema,
  gateInputOf,
  type KitParts,
  NO_DECISIONS,
  type ReviewDecisions,
} from "./decisions";
import { anySent, asShown, isLive, type KitSend, latestSend, uncertainSend } from "./kitSends";

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
   * drafted the kit; "none_fit": the templates, when none fits the role.
   */
  status: "done" | "running" | "failed" | "waiting" | "not_checked" | "skipped" | "none_fit";
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
  kind: StateKind;
  receivedAt: Date;
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
  /** How the contact's second read settled; null before it ran, or for a role with no contact. */
  contact: { kind: ContactKind; agreement: Agreement } | null;
  /** The email address's checks; null before they ran, or for another route. */
  addressChecks: AddressCheck[] | null;
  application: { status: ApplicationStatus; sentAt: Date | null } | null;
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
];

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
  for (const stage of [...POST_STAGES, ...GEMINI_STAGES, "templates" as const]) {
    const kept = await stageOutput(deps.db, id, stage);
    if (kept) outputs.set(stage, kept.outputHash);
  }
  const extract = await stageOutput(deps.db, id, "extract");
  const extraction = extract ? readExtractOutput(extract.output) : null;
  const stopReason = extraction ? stopReasonOf(extraction) : null;
  const role = await chosenRole(deps.db, id);
  const draft = (await stageOutput(deps.db, id, "draft"))?.output as DraftOutput | undefined;
  const judge = (await stageOutput(deps.db, id, "judge"))?.output as
    JudgeOutput | PassedThrough | undefined;
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
  const settled: JobView["contact"] =
    read?.checked && contact
      ? {
          kind: contact.kind,
          agreement:
            read.kind === contact.kind && read.contact === contact.contact
              ? agreement(contact.kind, contact.contact, read.second)
              : { ok: false, reason: "no_second_read" },
        }
      : null;
  const addressChecks =
    contact?.kind === "email" ? addressChecksOf(contact.contact, checks, read) : null;
  const ready = job.state === "kit_ready";
  const application = role ? await applicationOf(deps.db, id, role.id) : null;
  const candidates =
    role && extraction
      ? await candidatesOf(deps.db, {
          role,
          visible: visibleRole(extraction.record, role),
          outputs,
          templates: round.templatesCurrent ? templates : undefined,
          gemini: geminiCurrent ? draft! : null,
          judge,
        })
      : [];
  const picked = role ? await pickedDraftOf(deps.db, id, role.id) : null;
  const chosen =
    candidates.find((candidate) => candidate.choice.id === picked) ?? candidates[0] ?? null;
  const hasKit = Boolean(chosen && role && extraction);
  const kitKey = hasKit ? chosen!.kitKey : null;
  const decisions = kitKey && role ? await decisionsOf(deps.db, id, role.id, kitKey) : null;
  // An address or number the owner typed stands once it passes, even where the kit would no
  // longer ask for one, as after an update that reads the post's as agreed: never the post's.
  const needsRetype = role
    ? needsRetypeOf(role, settled, addressChecks) || typedPasses(role, decisions ?? NO_DECISIONS)
    : false;
  const handoff = hasKit && role ? handoffOf(role, needsRetype, decisions ?? NO_DECISIONS) : null;
  // A kit that ran before its application opened with it is weighed against every earlier one
  // too, at the address it goes to.
  const duplicates = application
    ? await kitDuplicatesOf(deps.db, application.id)
    : ready && role && extraction
      ? await unopenedDuplicates(deps.db, role, extraction, handoff)
      : [];
  const latest = role ? await latestSend(deps.db, id, role.id) : null;
  const now = deps.clock.now();
  const sentByJobkit = role ? await anySent(deps.db, id, role.id) : false;
  const kitParts =
    chosen && role && extraction
      ? kitPartsOf({
          draft: chosen.draft,
          verdicts: chosen.verdicts,
          role,
          extraction,
          needsRetype,
          addressChecks,
          duplicates,
          sent:
            application?.status === "sent" ||
            application?.status === "submitted" ||
            application?.status === "bounced" ||
            // jobkit sent it, though the ledger may not have recorded it: it went.
            sentByJobkit,
          sending: latest !== null && isLive(latest, now),
        })
      : null;
  return {
    id,
    state: job.state,
    kind: kindOf(job.state),
    receivedAt: job.receivedAt,
    failure: await failureOf(deps.db, job),
    steps: await stepsOf(deps.db, job, unchecked, {
      drafted: round.templatesCurrent && (templates?.drafts.length ?? 0) > 0,
      noneFit: (templates?.drafts.length ?? 0) === 0,
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
    picked: chosen?.choice.id ?? null,
    canDraftWithGemini:
      ready &&
      candidates.length > 0 &&
      !candidates.some((candidate) => candidate.choice.source === "gemini") &&
      kitParts !== null &&
      !kitParts.sent &&
      !kitParts.sending,
    canGoBackToDrafts:
      job.state === "failed" &&
      (job.pendingStage === "draft" || job.pendingStage === "judge") &&
      candidates.some((candidate) => candidate.choice.source === "template"),
    judge: geminiCurrent && judge?.checked ? judge : null,
    contact: settled,
    addressChecks,
    application: application && { status: application.status, sentAt: application.sentAt },
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
  },
): Promise<Candidate[]> {
  const { role, outputs, templates, gemini, judge } = kit;
  const of = (stages: readonly StageName[]) =>
    Object.fromEntries([...outputs].filter(([stage]) => stages.includes(stage)));
  const candidates: Candidate[] = [];
  for (const draft of templates?.drafts ?? []) {
    if (draft.roleId !== role.id) continue;
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
    candidates.push({
      choice: choiceOf(gemini, verdicts, {
        id: GEMINI_DRAFT,
        source: "gemini",
        name: "",
        coverage: profile ? mustHaveCoverage(kit.visible, gemini.fit, profile.facts) : 0,
      }),
      draft: gemini,
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
  return draft.kit.blocks.map(
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
 * second read did not agree or never ran, or when one of its address's
 * checks holds it. The address the owner types is checked on its own.
 */
function needsRetypeOf(
  role: Role,
  settled: JobView["contact"],
  addressChecks: AddressCheck[] | null,
): boolean {
  const { kind, address } = role.route;
  if (kind !== "email" && kind !== "whatsapp") return false;
  const given = address.trim();
  const passes = kind === "email" ? isStrictAddress(given) : normaliseWhatsAppNumber(given).ok;
  const held = (addressChecks ?? []).some((check) => check.blocking);
  return given === "" || !passes || settled?.agreement.ok !== true || held;
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
  verdicts: KitParts["verdicts"];
  role: Role;
  extraction: ExtractOutput;
  needsRetype: boolean;
  addressChecks: AddressCheck[] | null;
  duplicates: JobView["duplicates"];
  sent: boolean;
  sending: boolean;
}): KitParts {
  const { kind } = parts.role.route;
  return {
    blocks: parts.draft.kit.blocks.map((block) => block.id),
    flags: parts.draft.flags,
    verdicts: parts.verdicts,
    attachments: parts.role.required_attachments.flatMap((attachment, i) =>
      attachment.is_cv ? [] : [{ id: `A${i + 1}`, name: attachment.name }],
    ),
    contact:
      kind === "email" || kind === "whatsapp" ? { kind, needsRetype: parts.needsRetype } : null,
    addressChecks: parts.addressChecks ?? [],
    scamSignals: [...parts.extraction.record.scam_signals, ...parts.extraction.backstop].map(
      (signal) => signal.quote || signal.kind,
    ),
    duplicates: duplicateParts(parts.duplicates),
    sent: parts.sent,
    sending: parts.sending,
  };
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
): Promise<ReviewDecisions> {
  const { rows } = await db.query<{ decisions: unknown; draft_checks: unknown }>(
    "select decisions, draft_checks from {{schema}}.kit_reviews where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  const parsed = storedDecisionsSchema.safeParse(rows[0]?.decisions);
  if (parsed.success && parsed.data.kit === kitKey) {
    const { checked, flagsChecked, retyped, attached, continueAnyway, lookups } = parsed.data;
    return { checked, flagsChecked, retyped, attached, continueAnyway, lookups };
  }
  // A draft the owner moved away from keeps its sentence and flag decisions aside, by its key, as
  // when the page falls back to it: those count again (draftChoice.ts).
  const aside = draftChecksSchema.safeParse(rows[0]?.draft_checks);
  const kept = aside.success ? aside.data[kitKey] : undefined;
  return kept ? { ...NO_DECISIONS, ...kept } : NO_DECISIONS;
}

/** Each draft's sentence and flag decisions, kept aside by its kit key while another is the kit. */
export const draftChecksSchema = z.record(
  z.string(),
  z.object({ checked: z.array(z.string()), flagsChecked: z.array(z.string()) }),
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
          if (stage === "templates") status = drafting.noneFit ? "none_fit" : "done";
          else status = unchecked.has(stage) ? "not_checked" : "done";
        }
        return { stage, label, status };
      })
  );
}

async function applicationOf(
  db: Db,
  jobId: string,
  roleId: string,
): Promise<{ id: string; status: ApplicationStatus; sentAt: Date | null } | null> {
  const { rows } = await db.query<{ id: string; status: ApplicationStatus; sent_at: Date | null }>(
    "select id, status, sent_at from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  return rows[0] ? { id: rows[0].id, status: rows[0].status, sentAt: rows[0].sent_at } : null;
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
  /** Whether the owner marked the chosen role's kit sent, as the job page shows it. */
  sent: boolean;
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
    output: unknown;
    output_hash: string | null;
    sent_roles: string[];
  }>(
    `select j.id, j.state, j.received_at, j.chosen_role, j.chosen_role_output,
            x.output, x.output_hash,
            array(select a.role_id from {{schema}}.applications as a
                   where a.job_id = j.id and a.status = 'sent') as sent_roles
       from {{schema}}.jobs as j
       left join lateral (
         select output, output_hash from {{schema}}.job_stage_runs as r
          where r.job_id = j.id and r.stage = 'extract' and r.outcome in ('ok', 'reused')
          order by r.id desc limit 1
       ) as x on true
      order by j.received_at desc
      limit $1`,
    [limit],
  );
  return rows.map((row) => {
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
      sent: role !== undefined && row.sent_roles.includes(role.id),
    };
  });
}
