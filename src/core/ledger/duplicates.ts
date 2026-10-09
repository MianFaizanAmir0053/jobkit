import type { Clock, Db } from "@/core/ports";

import { addressKey, companyRoleHash, similarity } from "./normalise";

/**
 * The duplicate check (ledger spec, "Duplicate check"; ADR 0001 entry 11 and
 * A16). A new application is compared with every earlier one: applications
 * sent or submitted, kits never sent, manual runs and the imported list.
 * Every match holds outbound actions until the owner taps "apply again".
 */
export type DuplicateReason = "company-role" | "address" | "post" | "drafted";

export interface DuplicateMatch {
  reason: DuplicateReason;
  source: "application" | "manual-run" | "earlier";
  /** The earlier application's company and role, so the banner can name them. */
  company: string;
  role: string;
  /** When it was sent or submitted, drafted, run, or applied for. */
  at: Date;
}

export interface Candidate {
  company: string;
  role: string;
  address: string | null;
  fingerprint: ReadonlySet<string>;
  /** The candidate's own application, which is not its own duplicate. */
  applicationId?: string;
}

/** Requirement trigrams shared from which two posts count as the same post. */
export const POST_SIMILARITY = 0.6;

type ApplicationRow = {
  company: string;
  role: string;
  company_role_hash: string | null;
  address: string | null;
  post_fingerprint: string[];
  kit_ready_at: Date;
  sent_at: Date | null;
  submitted_at: Date | null;
};

export async function findDuplicates(db: Db, candidate: Candidate): Promise<DuplicateMatch[]> {
  const hash = companyRoleHash(candidate.company, candidate.role);
  const address = candidate.address === null ? null : addressKey(candidate.address);
  const sameAddress = (other: string | null) => address !== null && other !== null && addressKey(other) === address;
  const matches: DuplicateMatch[] = [];

  // Every application that got as far as a kit: sent, submitted, bounced,
  // or never sent. Open ones are still being read, and test jobs are not
  // applications.
  const applications = await db.query<ApplicationRow>(
    `select company, role, company_role_hash, address, post_fingerprint,
            kit_ready_at, sent_at, submitted_at
       from {{schema}}.applications
      where kit_ready_at is not null and job_kind = 'real'
        and ($1::uuid is null or id <> $1)`,
    [candidate.applicationId ?? null],
  );
  for (const row of applications.rows) {
    const appliedAt = row.sent_at ?? row.submitted_at;
    const earlier = {
      source: "application" as const,
      company: row.company,
      role: row.role,
      at: appliedAt ?? row.kit_ready_at,
    };
    if (hash !== null && row.company_role_hash === hash) {
      matches.push({ ...earlier, reason: appliedAt ? "company-role" : "drafted" });
    }
    if (sameAddress(row.address)) matches.push({ ...earlier, reason: "address" });
    if (similarity(candidate.fingerprint, new Set(row.post_fingerprint)) >= POST_SIMILARITY) {
      matches.push({ ...earlier, reason: "post" });
    }
  }

  // Manual runs carry a company and role, typed at Stop, and nothing else.
  const runs = await db.query<{ company: string; role: string; stopped_at: Date }>(
    `select company, role, stopped_at from {{schema}}.baseline_runs where stopped_at is not null`,
  );
  for (const run of runs.rows) {
    if (hash !== null && companyRoleHash(run.company, run.role) === hash) {
      matches.push({
        reason: "company-role",
        source: "manual-run",
        company: run.company,
        role: run.role,
        at: run.stopped_at,
      });
    }
  }

  const imported = await db.query<{
    company: string;
    role: string;
    company_role_hash: string;
    address: string | null;
    applied_on: string;
  }>(
    `select company, role, company_role_hash, address, applied_on::text as applied_on
       from {{schema}}.earlier_applications`,
  );
  for (const row of imported.rows) {
    const earlier = {
      source: "earlier" as const,
      company: row.company,
      role: row.role,
      at: new Date(`${row.applied_on}T00:00:00Z`),
    };
    if (hash !== null && row.company_role_hash === hash) matches.push({ ...earlier, reason: "company-role" });
    if (sameAddress(row.address)) matches.push({ ...earlier, reason: "address" });
  }

  // Newest first; the sort keeps each application's reasons in order.
  return matches.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The matches for an application already recorded; null when there is none. */
export async function duplicatesOf(db: Db, applicationId: string): Promise<DuplicateMatch[] | null> {
  const found = await ownRow(db, applicationId);
  return found && found.matches;
}

/**
 * Whether outbound actions may go ahead for an application: with no
 * matches, or after the owner tapped "apply again". Null when there is no
 * such application.
 */
export async function duplicateGate(
  db: Db,
  applicationId: string,
): Promise<{ matches: DuplicateMatch[]; cleared: boolean } | null> {
  const found = await ownRow(db, applicationId);
  if (!found) return null;
  return { matches: found.matches, cleared: found.matches.length === 0 || found.applyAgainAt !== null };
}

/** The owner's "apply again" tap; a second tap changes nothing. */
export async function applyAgain(deps: { db: Db; clock: Clock }, applicationId: string): Promise<boolean> {
  const { rowCount } = await deps.db.query(
    `update {{schema}}.applications set apply_again_at = $2
      where id = $1 and apply_again_at is null`,
    [applicationId, deps.clock.now()],
  );
  return rowCount === 1;
}

async function ownRow(
  db: Db,
  applicationId: string,
): Promise<{ matches: DuplicateMatch[]; applyAgainAt: Date | null } | null> {
  const { rows } = await db.query<{
    company: string;
    role: string;
    address: string | null;
    post_fingerprint: string[];
    apply_again_at: Date | null;
  }>(
    `select company, role, address, post_fingerprint, apply_again_at
       from {{schema}}.applications where id = $1`,
    [applicationId],
  );
  const row = rows[0];
  if (!row) return null;
  const matches = await findDuplicates(db, {
    company: row.company,
    role: row.role,
    address: row.address,
    fingerprint: new Set(row.post_fingerprint),
    applicationId,
  });
  return { matches, applyAgainAt: row.apply_again_at };
}
