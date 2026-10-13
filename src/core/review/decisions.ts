import { z } from "zod";

import type { BlockVerdict } from "@/core/drafting/judge";
import type { KitFlag } from "@/core/drafting/validate";

import type { AddressCheck } from "./addressChecks";
import type { GateInput } from "./canHandOff";

/**
 * The owner's decisions on a kit (review spec, "The outbound gate"), kept
 * as one row per job and role in kit_reviews: the sentences marked "I
 * checked this", the address or number typed in place of a disputed or
 * missing one, the required attachments ticked, and "Continue anyway" on a
 * scam warning. "Apply again" stays on the application, where the ledger
 * keeps it. With what the kit holds, they make the gate's input; a
 * decision the kit no longer has a place for counts for nothing.
 */

export interface ReviewDecisions {
  checked: string[];
  retyped: string | null;
  attached: string[];
  continueAnyway: boolean;
}

export const NO_DECISIONS: ReviewDecisions = {
  checked: [],
  retyped: null,
  attached: [],
  continueAnyway: false,
};

export const decisionsSchema = z.object({
  checked: z.array(z.string()),
  retyped: z.string().nullable(),
  attached: z.array(z.string()),
  continueAnyway: z.boolean(),
});

/** One decision, as the page posts it. A typed contact fits RFC 5321's 254 characters with room. */
export const reviewActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("check"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("uncheck"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("retype"), value: z.string().max(320) }),
  z.strictObject({
    kind: z.literal("attach"),
    name: z.string().min(1).max(300),
    ticked: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("continue_anyway") }),
]);

export type ReviewAction = z.infer<typeof reviewActionSchema>;

const without = (list: readonly string[], item: string) => list.filter((each) => each !== item);
const withOne = (list: readonly string[], item: string) =>
  list.includes(item) ? [...list] : [...list, item];

/** The decisions after one action; the same action twice changes nothing more. */
export function decide(decisions: ReviewDecisions, action: ReviewAction): ReviewDecisions {
  switch (action.kind) {
    case "check":
      return { ...decisions, checked: withOne(decisions.checked, action.blockId) };
    case "uncheck":
      return { ...decisions, checked: without(decisions.checked, action.blockId) };
    case "retype": {
      const value = action.value.trim();
      return { ...decisions, retyped: value === "" ? null : value };
    }
    case "attach":
      return {
        ...decisions,
        attached: action.ticked
          ? withOne(decisions.attached, action.name)
          : without(decisions.attached, action.name),
      };
    case "continue_anyway":
      return { ...decisions, continueAnyway: true };
  }
}

/** What the gate reads from a kit, besides the owner's decisions. */
export interface KitParts {
  /** The kit's sentences, by ID. */
  blocks: readonly string[];
  flags: readonly KitFlag[];
  verdicts: readonly BlockVerdict[];
  /** The post's required attachments, by name. */
  attachments: readonly string[];
  /** An email or WhatsApp route's contact, and whether the owner must type it. */
  contact: { kind: "email" | "whatsapp"; needsRetype: boolean } | null;
  addressChecks: readonly AddressCheck[];
  scamSignals: readonly string[];
  /** The ledger's duplicate matches in words, each with whether "Apply again" covered it. */
  duplicates: readonly { reason: string; covered: boolean }[];
}

export function gateInputOf(parts: KitParts, decisions: ReviewDecisions): GateInput {
  const blocks = new Set(parts.blocks);
  const attached = new Set(decisions.attached);
  return {
    flags: parts.flags,
    verdicts: parts.verdicts,
    checked: decisions.checked.filter((id) => blocks.has(id)),
    unconfirmed: [],
    attachments: parts.attachments.map((name) => ({ name, ticked: attached.has(name) })),
    contact: parts.contact && { ...parts.contact, retyped: decisions.retyped },
    addressChecks: parts.addressChecks,
    duplicates: parts.duplicates.map((match) => ({
      reason: match.reason,
      applyAgain: match.covered,
    })),
    scam:
      parts.scamSignals.length > 0
        ? { signals: parts.scamSignals, overridden: decisions.continueAnyway }
        : null,
  };
}
