import type { Clock, Db } from "@/core/ports";

import { companyRoleHash, sameAddress, similarity } from "./normalise";

/**
 * The duplicate check (ledger spec, "Duplicate check"; ADR 0001 entry 11 and
 * A16). A new application is compared with every earlier one: applications
 * sent or submitted, kits never sent, manual runs and the imported list.
 * Every match holds outbound actions until the owner taps "apply again".
 * Company and role are compared by today's normalisation, never by a key
 * an older row stored, so a change to the rules reaches every row.
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
  /**
   * When the candidate's application was opened. A kit opened after it and
   * never sent does not hold it back; one that was sent does.
   */
  openedAt?: Date;
}

/** Requirement trigrams shared from which two posts count as the same post. */
export const POST_SIMILARITY = 0.6;

/** The fewest requirement trigrams a post needs on each side before it can match on post. */
export const MIN_POST_TRIGRAMS = 8;

/** A match, and when jobkit learned of it, which is what an "apply again" tap covers. */
interface Found {
  match: DuplicateMatch;
  foundAt: Date;
}

type ApplicationRow = {
  company: string;
  role: string;
  address: string | null;
  post_fingerprint: string[];
  kit_ready_at: Date;
  sent_at: Date | null;
  submitted_at: Date | null;
};

function samePost(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return (
    a.size >= MIN_POST_TRIGRAMS &&
    b.size >= MIN_POST_TRIGRAMS &&
    similarity(a, b) >= POST_SIMILARITY
  );
}

export async function findDuplicates(db: Db, candidate: Candidate): Promise<DuplicateMatch[]> {
  return (await found(db, candidate)).map((entry) => entry.match);
}

async function found(db: Db, candidate: Candidate): Promise<Found[]> {
  const hash = companyRoleHash(candidate.company, candidate.role);
  const sameCompanyRole = (company: string, role: string) =>
    hash !== null && companyRoleHash(company, role) === hash;
  const atAddress = (other: string | null) =>
    candidate.address !== null && other !== null && sameAddress(candidate.address, other);
  const results: Found[] = [];
  const add = (match: DuplicateMatch, foundAt = match.at) => results.push({ match, foundAt });

  // Every application that got as far as a kit: sent, submitted, bounced,
  // or never sent. Open ones are still being read, and test jobs are not
  // applications.
  const applications = await db.query<ApplicationRow>(
    `select company, role, address, post_fingerprint, kit_ready_at, sent_at, submitted_at
       from {{schema}}.applications
      where kit_ready_at is not null and job_kind = 'real'
        and ($1::uuid is null or id <> $1)
        and (sent_at is not null or submitted_at is not null
             or $2::timestamptz is null or opened_at < $2)`,
    [candidate.applicationId ?? null, candidate.openedAt ?? null],
  );
  for (const row of applications.rows) {
    const appliedAt = row.sent_at ?? row.submitted_at;
    const earlier = {
      source: "application" as const,
      company: row.company,
      role: row.role,
      at: appliedAt ?? row.kit_ready_at,
    };
    if (sameCompanyRole(row.company, row.role)) {
      add({ ...earlier, reason: appliedAt ? "company-role" : "drafted" });
    }
    if (atAddress(row.address)) add({ ...earlier, reason: "address" });
    if (samePost(candidate.fingerprint, new Set(row.post_fingerprint)))
      add({ ...earlier, reason: "post" });
  }

  // Manual runs carry a company and role, typed at Stop, and nothing else.
  const runs = await db.query<{ company: string; role: string; stopped_at: Date }>(
    `select company, role, stopped_at from {{schema}}.baseline_runs where stopped_at is not null`,
  );
  for (const run of runs.rows) {
    if (sameCompanyRole(run.company, run.role)) {
      add({
        reason: "company-role",
        source: "manual-run",
        company: run.company,
        role: run.role,
        at: run.stopped_at,
      });
    }
  }

  // An imported application is found when it is imported, however long ago it was made.
  const imported = await db.query<{
    company: string;
    role: string;
    address: string | null;
    applied_on: string;
    imported_at: Date;
  }>(
    `select company, role, address, applied_on::text as applied_on, imported_at
       from {{schema}}.earlier_applications`,
  );
  for (const row of imported.rows) {
    const earlier = {
      source: "earlier" as const,
      company: row.company,
      role: row.role,
      at: new Date(`${row.applied_on}T00:00:00Z`),
    };
    if (sameCompanyRole(row.company, row.role))
      add({ ...earlier, reason: "company-role" }, row.imported_at);
    if (atAddress(row.address)) add({ ...earlier, reason: "address" }, row.imported_at);
  }

  // Newest first; the sort keeps each application's reasons in order.
  return results.sort((a, b) => b.match.at.getTime() - a.match.at.getTime());
}

/** The matches for an application already recorded; null when there is none. */
export async function duplicatesOf(
  db: Db,
  applicationId: string,
): Promise<DuplicateMatch[] | null> {
  const own = await ownRow(db, applicationId);
  return own && own.found.map((entry) => entry.match);
}

/**
 * Whether outbound actions may go ahead for an application: with no
 * matches, or when the owner's last "apply again" tap came after every
 * match was found. Null when there is no such application.
 */
export async function duplicateGate(
  db: Db,
  applicationId: string,
): Promise<{ matches: DuplicateMatch[]; cleared: boolean } | null> {
  const own = await ownRow(db, applicationId);
  if (!own) return null;
  return { matches: own.found.map((entry) => entry.match), cleared: isCleared(own) };
}

/**
 * The owner's "apply again" tap. It covers every match found so far; one
 * found later holds the application again until the next tap. A tap with
 * nothing to cover, such as the second of a double tap, changes nothing.
 */
export async function applyAgain(
  deps: { db: Db; clock: Clock },
  applicationId: string,
): Promise<boolean> {
  const own = await ownRow(deps.db, applicationId);
  if (!own || isCleared(own)) return false;
  await deps.db.query("update {{schema}}.applications set apply_again_at = $2 where id = $1", [
    applicationId,
    deps.clock.now(),
  ]);
  return true;
}

function isCleared(own: { found: Found[]; applyAgainAt: Date | null }): boolean {
  const tap = own.applyAgainAt;
  return own.found.every((entry) => tap !== null && entry.foundAt <= tap);
}

async function ownRow(
  db: Db,
  applicationId: string,
): Promise<{ found: Found[]; applyAgainAt: Date | null } | null> {
  const { rows } = await db.query<{
    company: string;
    role: string;
    address: string | null;
    post_fingerprint: string[];
    opened_at: Date;
    apply_again_at: Date | null;
  }>(
    `select company, role, address, post_fingerprint, opened_at, apply_again_at
       from {{schema}}.applications where id = $1`,
    [applicationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    found: await found(db, {
      company: row.company,
      role: row.role,
      address: row.address,
      fingerprint: new Set(row.post_fingerprint),
      applicationId,
      openedAt: row.opened_at,
    }),
    applyAgainAt: row.apply_again_at,
  };
}
