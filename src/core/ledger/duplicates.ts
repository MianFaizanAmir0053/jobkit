import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { companyRoleHash, sameAddress, similarity } from "./normalise";

/**
 * The duplicate check (ledger spec, "Duplicate check"; ADR 0001 entry 11 and
 * A16). A new application is compared with every earlier one: applications
 * sent or submitted, kits never sent, manual runs and the imported list.
 * Every match holds outbound actions until the owner taps "apply again" on
 * the banner that shows it. Company and role are compared by today's
 * normalisation, never by a key an older row stored, so a change to the
 * rules reaches every row.
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
  /**
   * Whether the earlier application went out: sent or submitted, run by
   * hand, or made before jobkit. False for a kit that was never sent.
   */
  applied: boolean;
  /** Whether the earlier application's email went and bounced. */
  bounced: boolean;
  /**
   * The match itself: the earlier row, the reason, and for an earlier kit
   * whether it was sent, and whether its email bounced. The banner sends the
   * keys it showed back with the owner's tap, and a match with any other key
   * holds the application again, a drafted kit that is later sent, and a
   * bounce that is later taken back, included.
   */
  key: string;
}

export interface Candidate {
  company: string;
  role: string;
  address: string | null;
  fingerprint: ReadonlySet<string>;
  /** The candidate's own application, which is not its own duplicate. */
  applicationId?: string;
  /**
   * When the candidate's application was opened, given with its ID. A kit
   * opened after it and never sent does not hold it back; one that was
   * sent does. Two opened at the same moment are ordered by ID, so exactly
   * one of them waits for the other.
   */
  openedAt?: Date;
}

/** Requirement trigrams shared from which two posts count as the same post. */
export const POST_SIMILARITY = 0.6;

/** Fingerprint tokens two posts must share, so one short line in common is never a match. */
export const MIN_SHARED_TRIGRAMS = 3;

type ApplicationRow = {
  id: string;
  company: string;
  role: string;
  address: string | null;
  post_fingerprint: string[];
  kit_ready_at: Date;
  sent_at: Date | null;
  submitted_at: Date | null;
  bounced_at: Date | null;
};

function samePost(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared >= MIN_SHARED_TRIGRAMS && similarity(a, b) >= POST_SIMILARITY;
}

export async function findDuplicates(db: Db, candidate: Candidate): Promise<DuplicateMatch[]> {
  const hash = companyRoleHash(candidate.company, candidate.role);
  const sameCompanyRole = (company: string, role: string) =>
    hash !== null && companyRoleHash(company, role) === hash;
  const atAddress = (other: string | null) =>
    candidate.address !== null && other !== null && sameAddress(candidate.address, other);
  const matches: DuplicateMatch[] = [];
  const add = (match: Omit<DuplicateMatch, "key">, id: string) =>
    matches.push({
      ...match,
      key: `${match.source}:${id}:${match.reason}${match.applied ? (match.bounced ? ":bounced" : "") : ":unsent"}`,
    });

  // Every application that got as far as a kit: sent, submitted, bounced,
  // or never sent, and every manual run that went, which had no kit. Open ones
  // are still being read, and test jobs are not applications.
  const applications = await db.query<ApplicationRow>(
    `select id, company, role, address, post_fingerprint, kit_ready_at, sent_at, submitted_at,
            bounced_at
       from {{schema}}.applications
      where (kit_ready_at is not null or arm = 'manual') and job_kind = 'real'
        and ($1::uuid is null or id <> $1)
        and (sent_at is not null or submitted_at is not null
             or $2::timestamptz is null or (opened_at, id) < ($2::timestamptz, $1::uuid))`,
    [candidate.applicationId ?? null, candidate.openedAt ?? null],
  );
  for (const row of applications.rows) {
    const appliedAt = row.sent_at ?? row.submitted_at;
    const earlier = {
      source: "application" as const,
      company: row.company,
      role: row.role,
      at: appliedAt ?? row.kit_ready_at,
      applied: appliedAt !== null,
      bounced: row.bounced_at !== null,
    };
    if (sameCompanyRole(row.company, row.role)) {
      add({ ...earlier, reason: appliedAt ? "company-role" : "drafted" }, row.id);
    }
    if (atAddress(row.address)) add({ ...earlier, reason: "address" }, row.id);
    if (samePost(candidate.fingerprint, new Set(row.post_fingerprint))) {
      add({ ...earlier, reason: "post" }, row.id);
    }
  }

  // Manual runs carry a company and role, typed at Stop, and nothing else.
  const runs = await db.query<{ id: string; company: string; role: string; stopped_at: Date }>(
    `select id, company, role, stopped_at from {{schema}}.baseline_runs where stopped_at is not null`,
  );
  for (const run of runs.rows) {
    if (sameCompanyRole(run.company, run.role)) {
      add(
        {
          reason: "company-role",
          source: "manual-run",
          company: run.company,
          role: run.role,
          at: run.stopped_at,
          applied: true,
          bounced: false,
        },
        run.id,
      );
    }
  }

  const imported = await db.query<{
    id: string;
    company: string;
    role: string;
    address: string | null;
    applied_on: string;
  }>(
    `select id, company, role, address, applied_on::text as applied_on
       from {{schema}}.earlier_applications`,
  );
  for (const row of imported.rows) {
    const earlier = {
      source: "earlier" as const,
      company: row.company,
      role: row.role,
      at: new Date(`${row.applied_on}T00:00:00Z`),
      applied: true,
      bounced: false,
    };
    if (sameCompanyRole(row.company, row.role)) add({ ...earlier, reason: "company-role" }, row.id);
    if (atAddress(row.address)) add({ ...earlier, reason: "address" }, row.id);
  }

  // Newest first; the sort keeps each application's reasons in order.
  return matches.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The matches for an application already recorded; null when there is none. */
export async function duplicatesOf(
  db: Db,
  applicationId: string,
): Promise<DuplicateMatch[] | null> {
  const own = await ownRow(db, applicationId);
  return own && own.matches;
}

/**
 * Whether outbound actions may go ahead for an application: with no
 * matches, or when the owner's taps covered every one. Null when there is
 * no such application.
 */
export async function duplicateGate(
  db: Db,
  applicationId: string,
): Promise<{ matches: DuplicateMatch[]; covers: string[]; cleared: boolean } | null> {
  const own = await ownRow(db, applicationId);
  if (!own) return null;
  const covered = new Set(own.covers);
  return {
    matches: own.matches,
    covers: own.covers,
    cleared: own.matches.every((match) => covered.has(match.key)),
  };
}

/**
 * The owner's "apply again" tap, with the keys of the matches its banner
 * showed: it covers those, and only those. One statement, so two taps at
 * once cover the same set; a tap that covers nothing new, such as the
 * second of a double tap, changes nothing and answers false.
 */
export async function applyAgain(
  deps: { db: Db; clock: Clock },
  applicationId: string,
  shown: readonly string[],
): Promise<boolean> {
  if (!isUuid(applicationId)) return false;
  const { rows } = await deps.db.query(
    `update {{schema}}.applications
        set apply_again_covers = array(
              select distinct unnest(apply_again_covers || $2::text[]) order by 1),
            apply_again_at = $3
      where id = $1 and not ($2::text[] <@ apply_again_covers)
      returning id`,
    [applicationId, [...shown], deps.clock.now()],
  );
  return rows.length === 1;
}

async function ownRow(
  db: Db,
  applicationId: string,
): Promise<{ matches: DuplicateMatch[]; covers: string[] } | null> {
  if (!isUuid(applicationId)) return null;
  const { rows } = await db.query<{
    company: string;
    role: string;
    address: string | null;
    post_fingerprint: string[];
    opened_at: Date;
    apply_again_covers: string[];
  }>(
    `select company, role, address, post_fingerprint, opened_at, apply_again_covers
       from {{schema}}.applications where id = $1`,
    [applicationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    matches: await findDuplicates(db, {
      company: row.company,
      role: row.role,
      address: row.address,
      fingerprint: new Set(row.post_fingerprint),
      applicationId,
      openedAt: row.opened_at,
    }),
    covers: row.apply_again_covers,
  };
}
