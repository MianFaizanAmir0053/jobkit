import { kitTypeOf } from "@/core/extraction/record";
import { isStrictAddress, normaliseWhatsAppNumber } from "@/core/extraction/contacts";
import { chosenRole, currentExtraction } from "@/core/extraction/owner";
import type { Role } from "@/core/extraction/record";
import { changeStatus, openApplication, type Route } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Pipeline, StageDefinition } from "@/core/platform/runner";
import type { Clock, Db } from "@/core/ports";

/**
 * The application's statuses as its job moves (ledger spec, "Statuses"):
 * it opens when a role is chosen, the post's one role as extract reads it
 * or the owner's pick of several, becomes kit_ready with the job, and is
 * skipped when the owner skips the job. Opening is what lets the duplicate
 * check hold a kit back, and "Apply again" be kept, before any handoff.
 * Each step is idempotent: a step taken again changes nothing.
 */

type Deps = { db: Db; clock: Clock };

/**
 * The kind of kit a role's route takes, as the ledger records it, by
 * drafting's route table; null for a route the owner must name.
 */
export function routeOf(kind: Role["route"]["kind"]): Route | null {
  return kitTypeOf(kind);
}

/**
 * The kind of kit the job's chosen role takes: the one its application
 * records, as the owner's pick of a kit type will set it, none while the
 * owner must name it; for a kit from before applications opened with their
 * jobs, its route's, as its application will open with. The job page, Mark
 * sent and Mark submitted decide by it, as the ledger does.
 */
export async function kitRouteOf(db: Db, jobId: string, role: Role): Promise<Route | null> {
  const { rows } = await db.query<{ route: Route | null }>(
    "select route from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, role.id],
  );
  const application = rows[0];
  return application ? application.route : routeOf(role.route.kind);
}

/**
 * A contact as the ledger keeps it, for the duplicate check: an email
 * address that passes the strict check, or a WhatsApp number that
 * normalises; none for anything else.
 */
export function contactForLedger(kind: Role["route"]["kind"], value: string): string | null {
  const contact = value.trim();
  if (kind === "email") return isStrictAddress(contact) ? contact : null;
  if (kind === "whatsapp") return normaliseWhatsAppNumber(contact).ok ? contact : null;
  return null;
}

/** The ID of the job's application for a role; null before it opens. */
export async function applicationIdOf(
  db: Db,
  jobId: string,
  roleId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id from {{schema}}.applications where job_id = $1 and role_id = $2",
    [jobId, roleId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Opens the job's application for its chosen role, with the post's
 * contact; its ID, or null while no role is chosen. A contact the owner
 * types on the review page replaces the post's (recordReview).
 */
export async function openForJob(
  deps: Deps,
  jobId: string,
  sessionId: string | null,
): Promise<string | null> {
  const extraction = await currentExtraction(deps.db, jobId);
  const role = await chosenRole(deps.db, jobId);
  if (!extraction || !role) return null;
  // The application takes its job's arm and kind: a test job's is a test job's, in no arm.
  const job = await loadJob(deps.db, jobId);
  const test = job?.test ?? false;
  return openApplication(
    deps,
    {
      jobId,
      roleId: role.id,
      company: extraction.record.company.name,
      role: role.title,
      address: contactForLedger(role.route.kind, role.route.address),
      route: routeOf(role.route.kind),
      requirements: role.requirements.map((requirement) => requirement.text),
      // A job drawn during real use is the tool arm's: the manual arm's run nothing.
      arm: test ? null : (job?.arm ?? null),
      jobKind: test ? "test" : "real",
    },
    sessionId,
  );
}

/**
 * The job reached its kit: its application, opened if need be, becomes
 * kit_ready. One already open keeps what the owner set on it since, the
 * address they typed and the kit type they picked: reaching the kit again,
 * as after a Gemini draft asked for beside the templates', changes
 * neither, while a new reading of the post opens it afresh at extract. The
 * session is the owner's when their tap opened it, as Apply again does on
 * a kit from before applications opened with their jobs.
 */
export async function kitReadyForJob(
  deps: Deps,
  jobId: string,
  sessionId: string | null = null,
): Promise<void> {
  const role = await chosenRole(deps.db, jobId);
  if (!role) return;
  const applicationId =
    (await applicationIdOf(deps.db, jobId, role.id)) ?? (await openForJob(deps, jobId, sessionId));
  if (applicationId) await changeStatus(deps, applicationId, "kit_ready", sessionId);
}

/** The owner skipped the job: its application, if a role was ever chosen, is skipped. */
export async function skippedForJob(
  deps: Deps,
  jobId: string,
  sessionId: string | null,
): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>(
    "select id from {{schema}}.applications where job_id = $1 and status in ('open', 'kit_ready')",
    [jobId],
  );
  for (const { id } of rows) await changeStatus(deps, id, "skipped", sessionId);
}

/** A stage whose transition is followed by a step of the application's, before the job moves. */
function after(
  stage: StageDefinition | undefined,
  step: (jobId: string, state: string) => Promise<void>,
): StageDefinition | undefined {
  if (!stage?.next) return stage;
  const next = stage.next.bind(stage);
  return {
    ...stage,
    async next(ctx, output) {
      const transition = await next(ctx, output);
      await step(ctx.job.id, transition.state);
      return transition;
    },
  };
}

/**
 * The pipeline with the application's statuses kept: extract opens it when
 * the post's one role goes on to eligibility (a pick of several opens it
 * at the owner's answer), and the stage that makes the kit ready, the
 * templates or the judge, marks it kit_ready with the job.
 */
export function trackApplications(pipeline: Pipeline, deps: Deps): Pipeline {
  const ready = async (jobId: string, state: string) => {
    if (state === "kit_ready") await kitReadyForJob(deps, jobId);
  };
  return {
    ...pipeline,
    extract: after(pipeline.extract, async (jobId, state) => {
      if (state === "checking") await openForJob(deps, jobId, null);
    }),
    templates: after(pipeline.templates, ready),
    judge: after(pipeline.judge, ready),
  };
}
