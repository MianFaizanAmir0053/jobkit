import type { DraftOutput } from "@/core/drafting/draftStage";
import type { BlockClass, EmailKit } from "@/core/drafting/kit";
import { templateFlags } from "@/core/drafting/templateDrafts";
import { type KitFlag, validateEmailKit } from "@/core/drafting/validate";
import type { JobRecord, Role } from "@/core/extraction/record";
import type { Db } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";

import { shortHash } from "./decisions";

/**
 * The owner's edits to a kit's sentences (drafting spec, "Owner edits";
 * review spec, "Job page", item 5): the email as it stands is the draft's,
 * with the owner's words for each sentence they edited; validate runs
 * again on it, as drafting ran it, so its flags are the email's as it
 * stands; and an edit of a claim, a gap line or a sentence about the post
 * is a factual one (ledger spec, "Factual edits").
 */

/** The email as it stands: the draft's, with the owner's words for each sentence they edited. */
export function editedKit(kit: EmailKit, edits: Readonly<Record<string, string>>): EmailKit {
  if (Object.keys(edits).length === 0) return kit;
  return {
    ...kit,
    blocks: kit.blocks.map((block) =>
      Object.hasOwn(edits, block.id) ? { ...block, text: edits[block.id]! } : block,
    ),
  };
}

/**
 * The email's words as a short key: the gate's answer names it, so a page
 * showing other words than the kit now has, as one drawn before an edit in
 * another tab, hands none of them off.
 */
export function wordsKey(kit: EmailKit): string {
  return shortHash(
    [
      kit.subject,
      kit.greeting,
      ...kit.blocks.map((block) => `${block.paragraphBreak ? "¶" : ""}${block.text}`),
      kit.closing,
    ].join("\n"),
  );
}

/**
 * validate's flags on the email as the owner edited it, as drafting ran it:
 * the draft's fit, limit, keyword, subject format and markers, the profile
 * version it was written with, and, for a template's draft, what only the
 * owner can confirm. With the profile version gone, drafting's flags stand.
 */
export async function flagsOfEdited(
  db: Db,
  input: {
    draft: DraftOutput;
    kit: EmailKit;
    record: JobRecord;
    role: Role;
    template: boolean;
  },
): Promise<KitFlag[]> {
  const profile = await getProfileVersion(db, input.draft.profileVersion);
  if (!profile) return input.draft.flags;
  const found = validateEmailKit(input.kit, {
    record: input.record,
    role: input.role,
    profile: {
      facts: profile.facts,
      knownGaps: profile.knownGaps,
      gapTemplates: profile.gapTemplates,
    },
    fit: input.draft.fit,
    wordLimit: input.draft.wordLimit,
    keyword: input.draft.keyword,
    subjectFormat: input.draft.subjectFormat ?? null,
    markers: input.draft.markers,
  });
  return input.template ? templateFlags(found, input.record, input.role) : found;
}

/** The classes of sentence whose edit is a factual one (ledger spec, "Factual edits"). */
export const FACTUAL_CLASSES: ReadonlySet<BlockClass> = new Set(["claim", "gap", "post"]);
