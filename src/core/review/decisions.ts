import { z } from "zod";

import type { KitFlag } from "@/core/drafting/validate";
import type { BlockVerdict } from "@/core/drafting/verdict";
import { isStrictAddress } from "@/core/extraction/contacts";

import type { AddressCheck } from "./addressChecks";
import type { GateInput } from "./canHandOff";

/**
 * The owner's decisions on a kit (review spec, "The outbound gate"), kept
 * as one row per job and role in kit_reviews, for the kit they were made on:
 * the sentences and the flags marked "I checked this", the address or
 * number typed in place of a disputed or missing one, with an address's
 * own checks, the required attachments the owner will attach, and
 * "Continue anyway" on a scam warning. "Apply again" stays on the
 * application, where the ledger keeps it. With what the kit holds, they
 * make the gate's input; a decision the kit has no place for counts for
 * nothing.
 */

/** A contact the owner typed: an email address with the checks made on it when typed. */
export interface TypedContact {
  value: string;
  /** An address's checks; null for a number, or for an address that fails the strict check. */
  checks: AddressCheck[] | null;
}

export interface ReviewDecisions {
  /** Sentences marked "I checked this", by block ID. */
  checked: string[];
  /** validate's flags marked "I checked this", by flagKey. */
  flagsChecked: string[];
  retyped: TypedContact | null;
  /** Required attachments the owner will attach in Gmail, by their place in the post's list ("A1"). */
  attached: string[];
  continueAnyway: boolean;
}

export const NO_DECISIONS: ReviewDecisions = {
  checked: [],
  flagsChecked: [],
  retyped: null,
  attached: [],
  continueAnyway: false,
};

const addressCheckSchema = z.object({
  kind: z.enum(["syntax", "mail_host", "free_mail", "company", "not_checked"]),
  blocking: z.boolean(),
  message: z.string(),
});

export const decisionsSchema = z.object({
  checked: z.array(z.string()),
  flagsChecked: z.array(z.string()),
  retyped: z
    .object({ value: z.string(), checks: z.array(addressCheckSchema).nullable() })
    .nullable(),
  attached: z.array(z.string()),
  continueAnyway: z.boolean(),
});

/** One decision, as the page posts it. A typed contact fits RFC 5321's 254 characters with room. */
export const reviewActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("check"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("uncheck"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("check_flag"), flag: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal("uncheck_flag"), flag: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal("retype"), value: z.string().max(320) }),
  z.strictObject({
    kind: z.literal("attach"),
    id: z.string().regex(/^A\d{1,3}$/),
    ticked: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("continue_anyway") }),
]);

export type ReviewAction = z.infer<typeof reviewActionSchema>;

/** A flag's name among the kit's: its kind and where it points. */
export function flagKey(flag: KitFlag): string {
  return `${flag.kind}:${flag.at}`;
}

const without = (list: readonly string[], item: string) => list.filter((each) => each !== item);
const withOne = (list: readonly string[], item: string) =>
  list.includes(item) ? [...list] : [...list, item];

/**
 * The decisions after one action; the same action twice changes nothing
 * more. A retype keeps the checks the caller made on the typed address, or
 * none.
 */
export function decide(
  decisions: ReviewDecisions,
  action: ReviewAction,
  typedChecks: AddressCheck[] | null = null,
): ReviewDecisions {
  switch (action.kind) {
    case "check":
      return { ...decisions, checked: withOne(decisions.checked, action.blockId) };
    case "uncheck":
      return { ...decisions, checked: without(decisions.checked, action.blockId) };
    case "check_flag":
      return { ...decisions, flagsChecked: withOne(decisions.flagsChecked, action.flag) };
    case "uncheck_flag":
      return { ...decisions, flagsChecked: without(decisions.flagsChecked, action.flag) };
    case "retype": {
      const value = action.value.trim();
      return { ...decisions, retyped: value === "" ? null : { value, checks: typedChecks } };
    }
    case "attach":
      return {
        ...decisions,
        attached: action.ticked
          ? withOne(decisions.attached, action.id)
          : without(decisions.attached, action.id),
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
  /**
   * The post's required attachments the owner says they will attach, by
   * their place in its list; not the CV, which the page says to attach in
   * Gmail.
   */
  attachments: readonly { id: string; name: string }[];
  /** An email or WhatsApp route's contact: whether the owner must type it in place of the post's. */
  contact: { kind: "email" | "whatsapp"; needsRetype: boolean } | null;
  /** The checks of the post's address, which hold the kit while it goes to that address. */
  addressChecks: readonly AddressCheck[];
  scamSignals: readonly string[];
  /** The ledger's duplicate matches in words, each with whether "Apply again" covered it. */
  duplicates: readonly { reason: string; covered: boolean }[];
  /** Whether the owner marked the kit sent. */
  sent: boolean;
}

/** A typed address with no checks kept: it holds the kit, as an address not checked does. */
const TYPED_NOT_CHECKED: AddressCheck = {
  kind: "not_checked",
  blocking: true,
  message: "The address you typed has not been checked. Type it again.",
};

/**
 * The checks of the address that goes out: the post's while the kit needs
 * no retype; the typed address's own once it passes the strict check (a
 * typed address that does not pass, or none typed yet, is the contact's
 * reason); none for a number.
 */
function checksOfAddressOut(
  parts: KitParts,
  retyped: TypedContact | null,
): readonly AddressCheck[] {
  if (parts.contact?.kind !== "email") return [];
  if (!parts.contact.needsRetype) return parts.addressChecks;
  if (!retyped || !isStrictAddress(retyped.value)) return [];
  return retyped.checks ?? [TYPED_NOT_CHECKED];
}

export function gateInputOf(parts: KitParts, decisions: ReviewDecisions): GateInput {
  const blocks = new Set(parts.blocks);
  const flagsChecked = new Set(decisions.flagsChecked);
  const attached = new Set(decisions.attached);
  return {
    sent: parts.sent,
    flags: parts.flags.filter((flag) => !flagsChecked.has(flagKey(flag))),
    verdicts: parts.verdicts.filter((verdict) => blocks.has(verdict.blockId)),
    checked: decisions.checked.filter((id) => blocks.has(id)),
    // Confirming a changed sentence comes with the block editor (Task 29).
    unconfirmed: [],
    attachments: parts.attachments.map(({ id, name }) => ({ name, ticked: attached.has(id) })),
    contact: parts.contact && { ...parts.contact, retyped: decisions.retyped?.value ?? null },
    addressChecks: checksOfAddressOut(parts, decisions.retyped),
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
