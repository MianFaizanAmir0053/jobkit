import type { DraftOutput } from "@/core/drafting/draftStage";
import type { BlockClass, EmailKit, KitBlock } from "@/core/drafting/kit";
import { templateFlags } from "@/core/drafting/templateDrafts";
import { type KitFlag, validateEmailKit } from "@/core/drafting/validate";
import type { JobRecord, Role } from "@/core/extraction/record";
import type { Db } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";

import { type ReviewDecisions, shortHash } from "./decisions";

/**
 * The owner's edits to a kit's sentences (drafting spec, "Owner edits";
 * review spec, "Job page", item 5): the email as it stands is the draft's,
 * with the owner's words for each sentence they edited; validate runs
 * again on it, as drafting ran it, so its flags are the email's as it
 * stands; and an edit of a claim, a gap line or a sentence about the post
 * is a factual one (ledger spec, "Factual edits").
 */

type Owners = Pick<ReviewDecisions, "edits" | "added" | "deleted">;

/**
 * The email as it stands: the draft's, with the owner's words for each
 * sentence they edited, the sentences they added where they put them, and
 * none they deleted; the draft's own while they changed nothing. Their
 * words are marked as theirs (`owner`), which validate checks for what
 * they say, never against facts.
 */
export function editedKit(kit: EmailKit, decisions: Owners): EmailKit {
  const { edits, added, deleted } = decisions;
  if (Object.keys(edits).length === 0 && added.length === 0 && deleted.length === 0) return kit;
  // A deleted sentence goes; the paragraph it ended ends with the sentence before it.
  const kept: KitBlock[] = [];
  for (const block of withOwnersWords(kit, decisions)) {
    if (!deleted.includes(block.id)) {
      kept.push(block);
      continue;
    }
    const last = kept.at(-1);
    if (block.paragraphBreak && last) kept[kept.length - 1] = { ...last, paragraphBreak: true };
  }
  return { ...kit, blocks: kept };
}

/**
 * The email's sentences as the page lists them: the email as it stands,
 * with each sentence the owner deleted in its place, marked deleted, so
 * they can take the deletion back.
 */
export function listedSentences(
  kit: EmailKit,
  decisions: Owners,
): { block: KitBlock; deleted: boolean }[] {
  return withOwnersWords(kit, decisions).map((block) => ({
    block,
    deleted: decisions.deleted.includes(block.id),
  }));
}

/** The draft's sentences with the owner's words for each they edited, and theirs where they added them. */
function withOwnersWords(kit: EmailKit, { edits, added }: Owners): KitBlock[] {
  const blocks: KitBlock[] = kit.blocks.map((block) =>
    Object.hasOwn(edits, block.id) ? { ...block, text: edits[block.id]!, owner: true } : block,
  );
  // Each added sentence after the one it names (the last, were that gone), or first, in the order
  // added: it ends the paragraph the sentence before it ended, and cites nothing.
  for (const sentence of added) {
    const named = blocks.findIndex((block) => block.id === sentence.after);
    const at = sentence.after === "" ? -1 : named === -1 ? blocks.length - 1 : named;
    const before = blocks[at];
    blocks.splice(at + 1, 0, {
      id: sentence.id,
      text: sentence.text,
      paragraphBreak: before?.paragraphBreak ?? false,
      class: "claim",
      factIds: [],
      fields: [],
      gap: null,
      owner: true,
    });
    if (before) blocks[at] = { ...before, paragraphBreak: false };
  }
  return blocks;
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
