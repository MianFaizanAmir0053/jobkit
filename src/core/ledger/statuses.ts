import { claimOne } from "@/core/platform/claim";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

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

/** "Mark sent" follows a Gmail handoff; "Mark submitted" is for forms and messages. */
const ROUTES_FOR: Partial<Record<ApplicationStatus, readonly Route[]>> = {
  sent: ["email"],
  submitted: ["form", "message"],
};

/**
 * The statuses the owner's own taps make, each with the status the tap
 * found the application in, so a mistaken tap can be taken back. A skip
 * before a kit closed its job (platform spec B9), so only a skip after the
 * kit can be.
 */
const UNDO_TO: Readonly<Record<"sent" | "submitted" | "bounced" | "skipped", ApplicationStatus>> = {
  sent: "kit_ready",
  submitted: "kit_ready",
  bounced: "sent",
  skipped: "kit_ready",
};

type Deps = { db: Db; clock: Clock };

export interface NewApplication {
  jobId: string;
  /** The extracted role's ID in its job (SPEC-extraction, roles[].id), so two roles written alike stay apart. */
  roleId: string;
  company: string;
  role: string;
  address: string | null;
  route: Route | null;
  /** The role's requirement texts, kept only as a fingerprint for the duplicate check. */
  requirements: readonly string[];
  arm: "tool" | "manual" | null;
  jobKind: "real" | "evaluation" | "test";
}

/**
 * A role was chosen: the application starts as `open`, with its keys and an
 * audit row. Each role of a post is its own application, by its role ID.
 * Picking the same role again, after a double tap or a new extraction, gets
 * the same application, which takes what the extraction read now while no
 * kit has gone out; once one has, the application stays as it went.
 */
export async function openApplication(
  deps: Deps,
  application: NewApplication,
  sessionId: string | null,
): Promise<string> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    // xmax is 0 on a row this statement inserted, and set on one it updated.
    const { rows } = await tx.query<{ id: string; inserted: boolean }>(
      `insert into {{schema}}.applications as applications
         (job_id, role_id, company, role, company_key, role_key, company_role_hash, address, route,
          post_fingerprint, status, opened_at, status_changed_at, arm, job_kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $11, $12, $13)
       on conflict (job_id, role_id) do update
         set company = excluded.company, role = excluded.role, company_key = excluded.company_key,
             role_key = excluded.role_key, company_role_hash = excluded.company_role_hash,
             address = excluded.address, route = excluded.route,
             post_fingerprint = excluded.post_fingerprint
         where applications.status in ('open', 'kit_ready')
       returning id, (xmax = 0) as inserted`,
      [
        application.jobId,
        application.roleId,
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
    const row = rows[0];
    if (row === undefined) {
      const sent = await tx.query<{ id: string }>(
        "select id from {{schema}}.applications where job_id = $1 and role_id = $2",
        [application.jobId, application.roleId],
      );
      return sent.rows[0]!.id;
    }
    if (row.inserted) await recordChange(tx, row.id, null, "open", now, sessionId);
    return row.id;
  });
}

export type StatusChange =
  | { ok: true; changed: boolean; status: ApplicationStatus }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "refused"; status: ApplicationStatus }
  /** "Mark sent" on a kit whose route is not email, or "Mark submitted" on an email one, or either before a route is known. */
  | { ok: false; reason: "wrong-route"; status: ApplicationStatus; route: Route | null };

/** The route the owner picked for the kit, while the application is open or its kit ready. */
export async function setRoute(
  deps: { db: Db },
  applicationId: string,
  route: Route,
): Promise<boolean> {
  if (!isUuid(applicationId)) return false;
  const { rowCount } = await deps.db.query(
    "update {{schema}}.applications set route = $2 where id = $1 and status in ('open', 'kit_ready')",
    [applicationId, route],
  );
  return rowCount === 1;
}

/**
 * The address the owner confirmed or corrected on the review page, while
 * no kit has gone out. A new address can find new duplicate matches, which
 * the owner's earlier "apply again" taps do not cover.
 */
export async function setAddress(
  deps: { db: Db },
  applicationId: string,
  address: string,
): Promise<boolean> {
  if (!isUuid(applicationId)) return false;
  const { rowCount } = await deps.db.query(
    "update {{schema}}.applications set address = $2 where id = $1 and status in ('open', 'kit_ready')",
    [applicationId, address],
  );
  return rowCount === 1;
}

/**
 * Moves an application to `to` if the table allows it from where it is,
 * and, for "Mark sent" and "Mark submitted", on that route. The move is one
 * conditional update, so two taps at once record once; a tap that finds
 * the application already there changes nothing.
 */
export async function changeStatus(
  deps: Deps,
  applicationId: string,
  to: ApplicationStatus,
  sessionId: string | null,
): Promise<StatusChange> {
  if (!isUuid(applicationId)) return { ok: false, reason: "not-found" };
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
              and ($5::text[] is null or route = any($5::text[]))
            for update
         )
         update {{schema}}.applications a
            set status = $3, status_changed_at = $4, ${TIME_COLUMN[to]} = $4
           from previous
          where a.id = previous.id
         returning previous.status as from_status`,
        [applicationId, from, to, now, ROUTES_FOR[to] ?? null],
      );
      if (moved) {
        await recordChange(tx, applicationId, moved.from_status, to, now, sessionId);
        return { ok: true, changed: true, status: to };
      }
    }
    const { rows } = await tx.query<{ status: ApplicationStatus; route: Route | null }>(
      "select status, route from {{schema}}.applications where id = $1",
      [applicationId],
    );
    const current = rows[0];
    if (current === undefined) return { ok: false, reason: "not-found" };
    if (current.status === to) return { ok: true, changed: false, status: to };
    if (from.includes(current.status) && ROUTES_FOR[to] !== undefined) {
      return { ok: false, reason: "wrong-route", status: current.status, route: current.route };
    }
    return { ok: false, reason: "refused", status: current.status };
  });
}

/**
 * Takes back a mistaken tap from the job's menu (ledger spec, "Statuses"):
 * the application goes back to the status the tap found it in, the tap's
 * time is cleared, and an audit row records the change. `last` is the
 * change the menu showed, its status and time, so a second tap, or a late
 * one after the owner has tapped again, changes nothing. It is one
 * conditional update; times come from the app's clock in whole
 * milliseconds, so they compare exactly.
 */
export async function undoStatus(
  deps: Deps,
  applicationId: string,
  last: { status: ApplicationStatus; at: Date },
  sessionId: string | null,
): Promise<StatusChange> {
  if (!isUuid(applicationId)) return { ok: false, reason: "not-found" };
  const now = deps.clock.now();
  const tapped = Object.hasOwn(UNDO_TO, last.status) ? (last.status as keyof typeof UNDO_TO) : null;
  return deps.db.tx(async (tx) => {
    if (tapped !== null) {
      const undone = await claimOne<{ id: string }>(
        tx,
        `update {{schema}}.applications
            set status = $2, status_changed_at = $5, ${TIME_COLUMN[tapped]} = null
          where id = $1 and status = $3 and status_changed_at = $4
            and ($3 <> 'skipped' or kit_ready_at is not null)
          returning id`,
        [applicationId, UNDO_TO[tapped], tapped, last.at, now],
      );
      if (undone) {
        await recordChange(tx, applicationId, tapped, UNDO_TO[tapped], now, sessionId);
        return { ok: true, changed: true, status: UNDO_TO[tapped] };
      }
    }
    const { rows } = await tx.query<{ status: ApplicationStatus }>(
      "select status from {{schema}}.applications where id = $1",
      [applicationId],
    );
    const current = rows[0]?.status;
    if (current === undefined) return { ok: false, reason: "not-found" };
    if (tapped !== null && current === UNDO_TO[tapped] && current !== tapped) {
      return { ok: true, changed: false, status: current };
    }
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
