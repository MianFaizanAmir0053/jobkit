import { createHash } from "node:crypto";

import type { Clock, Db, Storage } from "@/core/ports";

import type { ProfileDocument } from "./schema";

/**
 * Loads a checked profile as a version (profile spec, "Seeding", steps 3
 * to 5). A version with the same hash is made active again instead, which
 * is how the owner rolls back. The CV goes to storage once per content.
 */
export interface SeedInput {
  profile: ProfileDocument;
  cv: Uint8Array;
  styleExamples: readonly string[];
  hash: string;
}

export type SeedResult = {
  status: "created" | "reactivated" | "unchanged";
  versionId: string;
};

export async function seedProfile(
  deps: { db: Db; storage: Storage; clock: Clock },
  input: SeedInput,
): Promise<SeedResult> {
  const { rows } = await deps.db.query<{ id: string; active: boolean }>(
    "select id, active from {{schema}}.profile_versions where hash = $1",
    [input.hash],
  );
  const existing = rows[0];
  if (existing?.active) return { status: "unchanged", versionId: existing.id };
  if (existing) {
    await activate(deps.db, existing.id);
    return { status: "reactivated", versionId: existing.id };
  }

  const cvPath = `profile/cv-${createHash("sha256").update(input.cv).digest("hex")}.pdf`;
  if ((await deps.storage.stat(cvPath)) === null) {
    await deps.storage.put(cvPath, input.cv, "application/pdf");
  }
  const versionId = await deps.db.tx(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into {{schema}}.profile_versions
         (hash, document, style_examples, cv_path, cv_label, created_at)
       values ($1, $2::jsonb, $3, $4, $5, $6)
       returning id`,
      [
        input.hash,
        JSON.stringify(input.profile),
        [...input.styleExamples],
        cvPath,
        input.profile.cv.label,
        deps.clock.now(),
      ],
    );
    const id = inserted.rows[0]!.id;
    await activate(tx, id);
    return id;
  });
  return { status: "created", versionId };
}

/** The one active version; the old one is let go first, as the unique index on active wants. */
async function activate(db: Db, versionId: string): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      "update {{schema}}.profile_versions set active = false where active and id <> $1",
      [versionId],
    );
    await tx.query("update {{schema}}.profile_versions set active = true where id = $1", [
      versionId,
    ]);
  });
}
