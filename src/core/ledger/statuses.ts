import { claimOne } from "@/core/platform/claim";
import type { Clock, Db } from "@/core/ports";

import { companyKey, companyRoleHash, postFingerprint, roleKey } from "./normalise";

/**
 * An application's statuses (ledger spec, "Statuses"). Only the moves in
 * the table are allowed, each writes an audit row, and a second tap on the
 * same button changes nothing.
 */
export type ApplicationStatus = "open" | "kit_ready" | "sent" | "submitted" | "skipped" | "bounced";
export type Route = "email" | "form" | "message";

export const TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  open: ["kit_ready", "skipped"],
  kit_ready: ["sent", "submitted", "skipped"],
  sent: ["bounced"],
  submitted: [],
  skipped: [],
  bounced: [],
};

/** Each status after `open` stamps its own time on the application. */
const TIME_COLUMN: Readonly<Record<Exclude<ApplicationStatus, "open">, string>> = {
  kit_ready: "kit_ready_at",
  sent: "sent_at",
  submitted: "submitted_at",
  skipped: "skipped_at",
  bounced: "bounced_at",
};

type Deps = { db: Db; clock: Clock };

export interface NewApplication {
  jobId: string;
  company: string;
  role: string;
  address: string | null;
  route: Route | null;
  /** The role's requirement texts, kept only as a fingerprint for the duplicate check. */
  requirements: readonly string[];
  arm: "tool" | "manual" | null;
  jobKind: "real" | "evaluation" | "test";
}

/** A role was chosen: the application starts as `open`, with its keys and an audit row. */
export async function openApplication(
  deps: Deps,
  application: NewApplication,
  sessionId: string | null,
): Promise<string> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into {{schema}}.applications
         (job_id, company, role, company_key, role_key, company_role_hash, address, route,
          post_fingerprint, status, opened_at, status_changed_at, arm, job_kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $10, $11, $12)
       returning id`,
      [
        application.jobId,
        application.company,
        application.role,
        companyKey(application.company),
        roleKey(application.role),
        companyRoleHash(application.company, application.role),
        application.address,
        application.route,
        [...postFingerprint(application.requirements)],
        now,
        application.arm,
        application.jobKind,
      ],
    );
    const id = rows[0]!.id;
    await recordChange(tx, id, null, "open", now, sessionId);
    return id;
  });
}

export type StatusChange =
  | { ok: true; changed: boolean; status: ApplicationStatus }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "refused"; status: ApplicationStatus };

/**
 * Moves an application to `to` if the table allows it from where it is.
 * The move is one conditional update, so two taps at once record once; a
 * tap that finds the application already there changes nothing.
 */
export async function changeStatus(
  deps: Deps,
  applicationId: string,
  to: ApplicationStatus,
  sessionId: string | null,
): Promise<StatusChange> {
  const now = deps.clock.now();
  const from = (Object.keys(TRANSITIONS) as ApplicationStatus[]).filter((status) =>
    TRANSITIONS[status].includes(to),
  );
  return deps.db.tx(async (tx) => {
    if (to !== "open") {
      const moved = await claimOne<{ from_status: ApplicationStatus }>(
        tx,
        `with previous as (
           select id, status from {{schema}}.applications
            where id = $1 and status = any($2::text[])
            for update
         )
         update {{schema}}.applications a
            set status = $3, status_changed_at = $4, ${TIME_COLUMN[to]} = $4
           from previous
          where a.id = previous.id
         returning previous.status as from_status`,
        [applicationId, from, to, now],
      );
      if (moved) {
        await recordChange(tx, applicationId, moved.from_status, to, now, sessionId);
        return { ok: true, changed: true, status: to };
      }
    }
    const { rows } = await tx.query<{ status: ApplicationStatus }>(
      "select status from {{schema}}.applications where id = $1",
      [applicationId],
    );
    const current = rows[0]?.status;
    if (current === undefined) return { ok: false, reason: "not-found" };
    if (current === to) return { ok: true, changed: false, status: to };
    return { ok: false, reason: "refused", status: current };
  });
}

async function recordChange(
  db: Db,
  applicationId: string,
  from: ApplicationStatus | null,
  to: ApplicationStatus,
  at: Date,
  sessionId: string | null,
): Promise<void> {
  await db.query(
    `insert into {{schema}}.status_changes (application_id, from_status, to_status, changed_at, session_id)
     values ($1, $2, $3, $4, $5)`,
    [applicationId, from, to, at, sessionId],
  );
}
