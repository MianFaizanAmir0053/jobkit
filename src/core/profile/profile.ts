import type { Db } from "@/core/ports";

import type { Fact, FixedAnswers, GapTemplate, KnownGap, ProfileDocument } from "./schema";

/**
 * The profile as other modules see it (profile spec, "Access API"). Only
 * approved facts and known gap lines leave this module; unapproved ones stay
 * in the stored document.
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
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from {{schema}}.profile_versions where id = $1`,
    [versionId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

export interface ProfileCounts {
  hash: string;
  facts: { approved: number; waiting: number };
  knownGaps: { approved: number; waiting: number };
}

/**
 * For the Profile page: how many of a version's items are approved and how
 * many wait, never the waiting ones. It takes the version the page already
 * shows, so a seed in between cannot mix two versions on one page.
 */
export async function profileCounts(db: Db, versionId: string): Promise<ProfileCounts | null> {
  const { rows } = await db.query<{ hash: string; document: ProfileDocument }>(
    "select hash, document from {{schema}}.profile_versions where id = $1",
    [versionId],
  );
  const row = rows[0];
  if (!row) return null;
  const count = (items: readonly { approved: boolean }[]) => ({
    approved: items.filter((item) => item.approved).length,
    waiting: items.filter((item) => !item.approved).length,
  });
  return {
    hash: row.hash,
    facts: count(row.document.facts),
    knownGaps: count(row.document.gaps.known),
  };
}
