import type { DraftOutput } from "@/core/drafting/draftStage";
import type { JudgeOutput } from "@/core/drafting/judgeStage";
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
import type { ApplicationStatus } from "@/core/ledger/statuses";
import { expireUploads, type Job, jobStatus } from "@/core/platform/jobs";
import { kindOf, type JobState, type StageName, type StateKind } from "@/core/platform/jobStates";
import { stageOutput } from "@/core/platform/runner";
import type { Clock, Db } from "@/core/ports";

import type { AddressCheck } from "./addressChecks";
import type { AddressChecksOutput } from "./addressChecksStage";
import { canHandOff, type GateReason } from "./canHandOff";
import {
  decisionsSchema,
  gateInputOf,
  type KitParts,
  NO_DECISIONS,
  type ReviewDecisions,
} from "./decisions";

/**
 * What the job page and the jobs list show (review spec, as far as the thin
 * path goes): the job's state and steps, what extract read, why it stopped,
 * the chosen role, the kit and whether it was sent. Reading a job applies
 * its upload timeout first, as every status read does (platform spec B9).
 */

export interface Step {
  stage: StageName;
  label: string;
  /** "not_checked": a stage whose output is from before its check was built. */
  status: "done" | "running" | "failed" | "waiting" | "not_checked";
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
  draft: DraftOutput | null;
  /** The judge's verdicts; null before it ran, or from before it was built. */
  judge: JudgeOutput | null;
  /** How the contact's second read settled; null before it ran, or for a role with no contact. */
  contact: { kind: ContactKind; agreement: Agreement } | null;
  /** The email address's checks; null before they ran, or for another route. */
  addressChecks: AddressCheck[] | null;
  application: { status: ApplicationStatus; sentAt: Date | null } | null;
  /** What the outbound gate reads from the kit; null before there is one. */
  kitParts: KitParts | null;
  /** The owner's decisions on the kit, and the gate's open reasons with them; null before there is a kit. */
  review: { decisions: ReviewDecisions; gate: GateReason[] } | null;
}

const NOT_CHECKED: AddressCheck = {
  kind: "not_checked",
  blocking: true,
  message: "This address has not been checked as it stands. Check it against the post.",
};

/** The thin path's stages, in order. */
const STEPS: readonly { stage: StageName; label: string }[] = [
  { stage: "extract", label: "Read the post" },
  { stage: "eligibility", label: "Check eligibility" },
  { stage: "draft", label: "Write the email" },
  { stage: "judge", label: "Check every sentence separately" },
];

/** The stages that run beside draft (B9), shown on its step: one that fails the job fails that step. */
const SHOWN_ON: Partial<Record<StageName, StageName>> = {
  address_read: "draft",
  address_checks: "draft",
};

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
  const kitParts =
    draft && role && extraction
      ? kitPartsOf({
          draft,
          verdicts: judge?.checked ? judge.verdicts : [],
          role,
          extraction,
          settled,
          addressChecks,
        })
      : null;
  const decisions = kitParts && role ? await decisionsOf(deps.db, id, role.id) : null;
  return {
    id,
    state: job.state,
    kind: kindOf(job.state),
    receivedAt: job.receivedAt,
    failure: await failureOf(deps.db, job),
    steps: await stepsOf(deps.db, job, unchecked),
    extraction,
    stopReason,
    canReadAgain:
      job.state === "stopped" &&
      (stopReason === "not_a_job_post" || stopReason === "no_role") &&
      !extraction!.postConfirmed,
    role,
    eligibility: eligibility?.checked ? eligibility : null,
    draftedAnyway: await draftedAnyway(deps.db, id),
    draft: draft ?? null,
    judge: judge?.checked ? judge : null,
    contact: settled,
    addressChecks,
    application: role ? await applicationOf(deps.db, id, role.id) : null,
    kitParts,
    review:
      kitParts && decisions
        ? { decisions, gate: canHandOff(gateInputOf(kitParts, decisions)) }
        : null,
  };
}

/**
 * What the gate reads from a kit. An email or WhatsApp contact must be
 * typed by the owner when the post gave none, when it fails the strict
 * check, or when its second read did not agree or never ran. Duplicate
 * matches come with the application, which the thin path opens only at
 * Mark sent: until it opens at the role pick, as the ledger spec has it,
 * none holds a kit back.
 */
function kitPartsOf(parts: {
  draft: DraftOutput;
  verdicts: KitParts["verdicts"];
  role: Role;
  extraction: ExtractOutput;
  settled: JobView["contact"];
  addressChecks: AddressCheck[] | null;
}): KitParts {
  const { kind, address } = parts.role.route;
  const typed = address.trim();
  const passes = kind === "email" ? isStrictAddress(typed) : normaliseWhatsAppNumber(typed).ok;
  return {
    blocks: parts.draft.kit.blocks.map((block) => block.id),
    flags: parts.draft.flags,
    verdicts: parts.verdicts,
    attachments: parts.role.required_attachments.map((attachment) => attachment.name),
    contact:
      kind === "email" || kind === "whatsapp"
        ? { kind, needsRetype: typed === "" || !passes || parts.settled?.agreement.ok !== true }
        : null,
    addressChecks: parts.addressChecks ?? [],
    scamSignals: [...parts.extraction.record.scam_signals, ...parts.extraction.backstop].map(
      (signal) => signal.quote || signal.kind,
    ),
    duplicates: [],
  };
}

/** The owner's decisions on a job's kit for a role, kept in kit_reviews; none before the first. */
export async function decisionsOf(db: Db, jobId: string, roleId: string): Promise<ReviewDecisions> {
  const { rows } = await db.query<{ decisions: unknown }>(
    "select decisions from {{schema}}.kit_reviews where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  const parsed = decisionsSchema.safeParse(rows[0]?.decisions);
  return parsed.success ? parsed.data : NO_DECISIONS;
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

async function stepsOf(db: Db, job: Job, unchecked: ReadonlySet<StageName>): Promise<Step[]> {
  const { rows } = await db.query<{ stage: StageName; outcome: string }>(
    `select distinct on (stage) stage, outcome from {{schema}}.job_stage_runs
      where job_id = $1 order by stage, id desc`,
    [job.id],
  );
  const last = new Map(rows.map((row) => [row.stage, row.outcome]));
  const failedStep = job.failedStage ? (SHOWN_ON[job.failedStage] ?? job.failedStage) : null;
  return STEPS.map(({ stage, label }) => {
    const outcome = last.get(stage);
    let status: Step["status"] = "waiting";
    // A stage running again, as after "Read it again", is running, whatever it gave before.
    if (job.state === "failed" && failedStep === stage) status = "failed";
    else if (kindOf(job.state) === "running" && job.pendingStage === stage) status = "running";
    else if (outcome === "ok" || outcome === "reused") {
      status = unchecked.has(stage) ? "not_checked" : "done";
    }
    return { stage, label, status };
  });
}

async function applicationOf(
  db: Db,
  jobId: string,
  roleId: string,
): Promise<JobView["application"]> {
  const { rows } = await db.query<{ status: ApplicationStatus; sent_at: Date | null }>(
    "select status, sent_at from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  return rows[0] ? { status: rows[0].status, sentAt: rows[0].sent_at } : null;
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
