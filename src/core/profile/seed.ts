import { createHash } from "node:crypto";

import type { Clock, Db, Storage } from "@/core/ports";

import type { CheckedProfile } from "./validate";

/**
 * Loads a checked profile as a version (profile spec, "Seeding", steps 3
 * to 5). A version with the same hash is made active again instead, which
 * is how the owner rolls back. The CV goes to storage once per content.
 */
export type SeedResult =
  | { status: "created" | "reactivated" | "unchanged"; versionId: string }
  | { status: "refused"; message: string };

type Deps = { db: Db; storage: Storage; clock: Clock };

const LABEL_TAKEN: SeedResult = {
  status: "refused",
  message: "cv.label already names a different CV in an earlier version; give this CV a new label",
};

export async function seedProfile(deps: Deps, input: CheckedProfile): Promise<SeedResult> {
  const existing = await versionWithHash(deps.db, input.hash);
  if (existing) return adopt(deps.db, existing);

  const cvPath = `profile/cv-${createHash("sha256").update(input.cv).digest("hex")}.pdf`;
  const label = input.profile.cv.label;
  // Checked here to spare the upload, and again where the version is stored.
  if (await labelTaken(deps.db, label, cvPath)) return LABEL_TAKEN;
  await storeCv(deps.storage, cvPath, input.cv);

  const outcome = await deps.db.tx(async (tx) => {
    // One seed at a time takes a label and stores a version, so a label never names two CVs.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", ["jobkit.profile_versions"]);
    if (await labelTaken(tx, label, cvPath)) return "label-taken" as const;
    const inserted = await tx.query<{ id: string }>(
      `insert into {{schema}}.profile_versions
         (hash, document, style_examples, cv_path, cv_label, created_at)
       values ($1, $2::jsonb, $3, $4, $5, $6)
       on conflict (hash) do nothing
       returning id`,
      [
        input.hash,
        JSON.stringify(input.profile),
        [...input.styleExamples],
        cvPath,
        label,
        deps.clock.now(),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) return "stored-already" as const;
    await activate(tx, id);
    return { id };
  });
  if (outcome === "label-taken") return LABEL_TAKEN;
  // Another seed of the same files stored it first.
  if (outcome === "stored-already")
    return adopt(deps.db, (await versionWithHash(deps.db, input.hash))!);
  return { status: "created", versionId: outcome.id };
}

/** Applications log the CV label, so a label names one CV. */
async function labelTaken(db: Db, label: string, cvPath: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from {{schema}}.profile_versions where cv_label = $1 and cv_path <> $2 limit 1",
    [label, cvPath],
  );
  return rows.length > 0;
}

/**
 * The CV in storage once per content. A copy cut short by an interrupted
 * upload is replaced; one another seed stored a moment ago is kept.
 */
async function storeCv(storage: Storage, path: string, cv: Uint8Array): Promise<void> {
  const stored = await storage.stat(path);
  if (stored?.size === cv.length) return;
  try {
    await storage.put(path, cv, "application/pdf", { overwrite: stored !== null });
  } catch (error) {
    if ((await storage.stat(path))?.size !== cv.length) throw error;
  }
}

/**
 * Makes a stored version active again by the start of its hash, as the seed
 * script's --list shows it: the way back to a version whose files the owner
 * no longer has.
 */
export async function activateByHash(db: Db, hashStart: string): Promise<SeedResult> {
  const start = hashStart.trim().toLowerCase();
  if (!/^[0-9a-f]{6,64}$/.test(start)) {
    return {
      status: "refused",
      message: "give at least the first 6 characters of a version's hash, as --list shows them",
    };
  }
  const { rows } = await db.query<{ id: string; active: boolean }>(
    "select id, active from {{schema}}.profile_versions where left(hash, $2) = $1 limit 2",
    [start, start.length],
  );
  if (rows.length === 0)
    return { status: "refused", message: `no stored version's hash starts with ${start}` };
  if (rows.length > 1) {
    return {
      status: "refused",
      message: `more than one stored version's hash starts with ${start}; give more of it`,
    };
  }
  return adopt(db, rows[0]!);
}

async function versionWithHash(
  db: Db,
  hash: string,
): Promise<{ id: string; active: boolean } | undefined> {
  const { rows } = await db.query<{ id: string; active: boolean }>(
    "select id, active from {{schema}}.profile_versions where hash = $1",
    [hash],
  );
  return rows[0];
}

async function adopt(db: Db, version: { id: string; active: boolean }): Promise<SeedResult> {
  if (version.active) return { status: "unchanged", versionId: version.id };
  await activate(db, version.id);
  return { status: "reactivated", versionId: version.id };
}

/** The one active version; the old one is let go first, as the unique index on active wants. */
export async function activate(db: Db, versionId: string): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      "update {{schema}}.profile_versions set active = false where active and id <> $1",
      [versionId],
    );
    const { rowCount } = await tx.query(
      "update {{schema}}.profile_versions set active = true where id = $1",
      [versionId],
    );
    // Rolls the deactivation back too, so a profile is never left without an active version.
    if (rowCount !== 1) throw new Error(`There is no profile version ${versionId}.`);
  });
}
