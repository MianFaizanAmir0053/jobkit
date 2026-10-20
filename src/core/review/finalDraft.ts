import { emailBody, formText, type Kit, messageText } from "@/core/drafting/kit";
import { isBlocking, NEVER_WEIGHED } from "@/core/drafting/verdict";
import type { Db } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";

import type { JobView } from "./jobView";

/**
 * What the ledger keeps of a kit that went (ledger spec, "Records"): its
 * final draft, the CV's label and the profile version it was drafted from,
 * on the application row; with the final draft, the sentences the owner
 * marked "I checked this" past the separate check's finding and sent
 * unchanged, each a judge false positive (ledger spec, "Factual edits"). A
 * sentence the check never weighed is no finding of its, so none.
 */

export interface FinalDraft {
  /** Which draft went: Gemini's, a template's, as the draft choice names it. */
  draft: string | null;
  kind: Kit["kind"];
  subject: string | null;
  /** The email's body, the message or the form's text, as it stood at the tap. */
  text: string;
  to: string;
  judgeFalsePositives: string[];
}

/** The kit's own words as they stand, by its kind. */
function textOf(kit: Kit): string {
  return kit.kind === "email"
    ? emailBody(kit)
    : kit.kind === "message"
      ? messageText(kit)
      : formText(kit);
}

/**
 * Keeps the final draft, the CV's label and the profile version on the
 * application, inside the caller's transaction: the kit as it stands at the
 * tap, as a handoff keeps only a key to its words. `went` gives which draft
 * went, where, and the blocks and fields the owner changed.
 */
export async function keepFinalDraft(
  db: Db,
  applicationId: string,
  view: JobView,
  went: {
    draft: string | null;
    to: string;
    changed: readonly string[];
  },
): Promise<void> {
  const kit = view.kit;
  if (!kit) return;
  const verdicts = view.kitParts?.verdicts ?? [];
  // A sentence the owner edited or deleted went in their words, or not at all: no false positive.
  const decisions = view.review?.decisions;
  const changed = new Set([
    ...went.changed.map((entry) => entry.replace(/^sentence:/, "")),
    ...Object.keys(decisions?.edits ?? {}),
    ...(decisions?.deleted ?? []),
  ]);
  const judgeFalsePositives = (decisions?.checked ?? []).filter(
    (blockId) =>
      !changed.has(blockId) &&
      verdicts.some(
        (verdict) =>
          verdict.blockId === blockId && isBlocking(verdict) && verdict.note !== NEVER_WEIGHED,
      ),
  );
  const finalDraft: FinalDraft = {
    draft: went.draft,
    kind: kit.kind,
    subject: kit.kind === "email" ? kit.subject : null,
    text: textOf(kit),
    to: went.to,
    judgeFalsePositives,
  };
  const profileVersion = view.draft?.profileVersion ?? null;
  const profile = profileVersion ? await getProfileVersion(db, profileVersion) : null;
  await db.query(
    `update {{schema}}.applications
        set final_draft = $2, cv_label = $3, profile_version = $4
      where id = $1`,
    [applicationId, JSON.stringify(finalDraft), profile?.cv.label ?? null, profileVersion],
  );
}
