import type { Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import type {
  EmailTemplate,
  Fact,
  FixedAnswers,
  GapTemplate,
  KnownGap,
  ProfileDocument,
} from "./schema";

/**
 * The profile as other modules see it (profile spec, "Access API"). Only
 * approved facts, known gap lines and email templates leave this module;
 * unapproved ones stay in the stored document.
 */
export interface Profile {
  versionId: string;
  createdAt: Date;
  owner: ProfileDocument["owner"];
  links: ProfileDocument["links"];
  signature: string;
  cv: { path: string; label: string };
  facts: Fact[];
  gapTemplates: GapTemplate[];
  knownGaps: KnownGap[];
  /** Approved email templates (decisions A21), each citing approved facts only. */
  emailTemplates: EmailTemplate[];
  fixedAnswers: FixedAnswers;
  styleExamples: string[];
}

type Row = {
  id: string;
  created_at: Date;
  document: ProfileDocument;
  style_examples: string[];
  cv_path: string;
  cv_label: string;
};

const COLUMNS = "id, created_at, document, style_examples, cv_path, cv_label";

/**
 * Versions are kept for good, for citation lookups, and their documents
 * were checked when they were seeded, so they are read as stored. A change
 * to the profile schema that older documents cannot be read under must
 * raise its `schema:` number and read older versions by theirs. An
 * optional addition keeps the number, and older documents read it as
 * missing: email_templates (decisions A21) reads as none.
 */
function toProfile(row: Row): Profile {
  const document = row.document;
  return {
    versionId: row.id,
    createdAt: row.created_at,
    owner: document.owner,
    links: document.links,
    signature: document.signature,
    cv: { path: row.cv_path, label: row.cv_label },
    facts: document.facts.filter((fact) => fact.approved),
    gapTemplates: document.gaps.templates,
    knownGaps: document.gaps.known.filter((gap) => gap.approved),
    // A version from before templates has none.
    emailTemplates: (document.email_templates ?? []).filter((template) => template.approved),
    fixedAnswers: document.fixed_answers,
    styleExamples: row.style_examples,
  };
}

export async function getActiveProfile(db: Db): Promise<Profile | null> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from {{schema}}.profile_versions where active`,
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

/** An older version, for citation lookups and evaluation runs. */
export async function getProfileVersion(db: Db, versionId: string): Promise<Profile | null> {
  if (!isUuid(versionId)) return null;
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from {{schema}}.profile_versions where id = $1`,
    [versionId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

/** Every stored version, newest first, for the seed script's --list. */
export async function listVersions(db: Db): Promise<
  {
    versionId: string;
    createdAt: Date;
    hash: string;
    active: boolean;
    facts: { approved: number; waiting: number };
  }[]
> {
  const { rows } = await db.query<{
    id: string;
    created_at: Date;
    hash: string;
    active: boolean;
    document: ProfileDocument;
  }>(
    "select id, created_at, hash, active, document from {{schema}}.profile_versions order by created_at desc",
  );
  return rows.map((row) => ({
    versionId: row.id,
    createdAt: row.created_at,
    hash: row.hash,
    active: row.active,
    facts: countApproved(row.document.facts),
  }));
}

function countApproved(items: readonly { approved: boolean }[]): {
  approved: number;
  waiting: number;
} {
  return {
    approved: items.filter((item) => item.approved).length,
    waiting: items.filter((item) => !item.approved).length,
  };
}

export interface ProfileCounts {
  hash: string;
  facts: { approved: number; waiting: number };
  knownGaps: { approved: number; waiting: number };
  emailTemplates: { approved: number; waiting: number };
}

/**
 * For the Profile page: how many of a version's items are approved and how
 * many wait, never the waiting ones. It takes the version the page already
 * shows, so a seed in between cannot mix two versions on one page.
 */
export async function profileCounts(db: Db, versionId: string): Promise<ProfileCounts | null> {
  if (!isUuid(versionId)) return null;
  const { rows } = await db.query<{ hash: string; document: ProfileDocument }>(
    "select hash, document from {{schema}}.profile_versions where id = $1",
    [versionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    hash: row.hash,
    facts: countApproved(row.document.facts),
    knownGaps: countApproved(row.document.gaps.known),
    emailTemplates: countApproved(row.document.email_templates ?? []),
  };
}
