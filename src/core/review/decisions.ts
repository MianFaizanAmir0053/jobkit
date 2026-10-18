import { z } from "zod";

import { type KitFlag, type KitFlagKind, ONLY_YOU_CAN_CONFIRM } from "@/core/drafting/validate";
import { type BlockVerdict, isBlocking } from "@/core/drafting/verdict";
import { isStrictAddress } from "@/core/extraction/contacts";

import { ADDRESS_CHECK_KINDS, ADDRESS_CHECKS_VERSION, type AddressCheck } from "./addressChecks";
import type { GateInput } from "./canHandOff";

/**
 * The owner's decisions on a kit (review spec, "The outbound gate"), kept
 * as one row per job and role in kit_reviews, for the kit they were made on:
 * the sentences and the flags marked "I checked this", the address or
 * number typed in place of a disputed or missing one, with an address's
 * own checks, the required attachments the owner will attach, the
 * requirements they say they meet, and "Continue anyway" on a scam
 * warning. "Apply again" stays on the
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

/**
 * The checks of an address the owner typed, as first found: kept with the
 * checks' version, so typing it again while DNS fails never turns a finding
 * that holds the kit into one that does not (review spec, "Stage
 * address_checks").
 */
export interface AddressLookup {
  address: string;
  version: number;
  checks: AddressCheck[];
}

export interface ReviewDecisions {
  /** Sentences marked "I checked this", by block ID. */
  checked: string[];
  /** validate's flags marked "I checked this", by their place among the kit's (flagKey). */
  flagsChecked: string[];
  retyped: TypedContact | null;
  /** Required attachments the owner will attach in Gmail, by their place in the post's list ("A1"). */
  attached: string[];
  continueAnyway: boolean;
  /** Every address the owner typed, with its checks as first found. */
  lookups: AddressLookup[];
  /**
   * The requirements the owner says they meet ("I meet this requirement"),
   * by ID: a decision on the post, which goes with a draft pick.
   */
  meets: string[];
}

export const NO_DECISIONS: ReviewDecisions = {
  checked: [],
  flagsChecked: [],
  retyped: null,
  attached: [],
  continueAnyway: false,
  lookups: [],
  meets: [],
};

const addressCheckSchema = z.object({
  kind: z.enum(ADDRESS_CHECK_KINDS),
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
  lookups: z.array(
    z.object({ address: z.string(), version: z.number(), checks: z.array(addressCheckSchema) }),
  ),
  // Kept from before the fit tick: none.
  meets: z.array(z.string()).default([]),
});

/** One decision, as the page posts it. A typed contact fits RFC 5321's 254 characters with room. */
export const reviewActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("check"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("uncheck"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("check_flag"), flag: z.string().regex(/^F\d{1,4}$/) }),
  z.strictObject({ kind: z.literal("uncheck_flag"), flag: z.string().regex(/^F\d{1,4}$/) }),
  z.strictObject({ kind: z.literal("retype"), value: z.string().max(320) }),
  z.strictObject({
    kind: z.literal("attach"),
    id: z.string().regex(/^A\d{1,3}$/),
    ticked: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("continue_anyway") }),
  z.strictObject({
    kind: z.literal("meets"),
    requirementId: z.string().regex(/^R\d{1,4}$/),
    ticked: z.boolean(),
  }),
]);

export type ReviewAction = z.infer<typeof reviewActionSchema>;

/**
 * A flag's name among the kit's: its place in validate's list ("F1"), so
 * two flags of one kind at one place are told apart, and a long place
 * never makes a name too long. Decisions count only for the kit they were
 * made on, so a place names one flag.
 */
export function flagKey(index: number): string {
  return `F${index + 1}`;
}

/**
 * Whether the owner's "I meet this requirement" clears a flag: one for a
 * requirement only they can confirm they meet, as validate words it (a
 * language or "other" one marked met, or a must-have the templates could
 * not weigh). Its "I checked this" clears it too, as for an owner who does
 * not meet it and sends the kit as it stands.
 */
export function isMeetable(flag: KitFlag): boolean {
  return flag.kind === "fit_unverified" && flag.message === ONLY_YOU_CAN_CONFIRM;
}

/** An email address without surrounding space or case, which change nothing about where it goes. */
export const emailKey = (address: string) => address.trim().toLowerCase();

/**
 * The checks kept for an address the owner typed before, in any case, at
 * the checks' version; null for none.
 */
export function keptLookup(decisions: ReviewDecisions, address: string): AddressCheck[] | null {
  const kept = decisions.lookups.find(
    (lookup) =>
      emailKey(lookup.address) === emailKey(address) && lookup.version === ADDRESS_CHECKS_VERSION,
  );
  return kept ? kept.checks : null;
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
      if (value === "") return { ...decisions, retyped: null };
      // The checks first found for this address stand; a later lookup never replaces them.
      const kept = keptLookup(decisions, value);
      const checks = kept ?? typedChecks;
      const lookups =
        kept === null && typedChecks !== null
          ? [
              ...decisions.lookups,
              { address: value, version: ADDRESS_CHECKS_VERSION, checks: typedChecks },
            ]
          : decisions.lookups;
      return { ...decisions, retyped: { value, checks }, lookups };
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
    case "meets":
      return {
        ...decisions,
        meets: action.ticked
          ? withOne(decisions.meets, action.requirementId)
          : without(decisions.meets, action.requirementId),
      };
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
  /** Whether the kit goes by email, through Gmail. */
  byEmail?: boolean;
  /** Whether it went as a form or a message the owner marked submitted. */
  submitted?: boolean;
  /** Whether jobkit is sending the kit from the owner's Gmail (decisions A20). */
  sending: boolean;
  /** Whether the owner skipped the job, its kit ready (ledger spec, "Statuses"). */
  skipped: boolean;
}

/**
 * validate's flags that make the email wrong to send as it stands: a line
 * the owner must write, a placeholder in the subject, a reference's
 * details, or a line written for an AI tool. Approve & send sends the
 * words as they stand, so a kit with one goes through Gmail, where the
 * owner changes them. Other flags new words would resolve (a missing
 * keyword, the length, a must-have with no gap line, no claims) leave the
 * email whole, and the press takes them as they are, as the confirmation
 * lists them.
 */
export const NEEDS_NEW_WORDS: ReadonlySet<KitFlagKind> = new Set([
  "needs_your_line",
  "subject_placeholder",
  "reference_leak",
  "ai_instruction_followed",
]);

/** Whether the kit's words must change before it goes, so Approve & send cannot send it. */
export function needsNewWords(
  parts: Pick<KitParts, "flags">,
  decisions: Pick<ReviewDecisions, "flagsChecked" | "meets"> = NO_DECISIONS,
): boolean {
  const checked = new Set(decisions.flagsChecked);
  const meets = new Set(decisions.meets);
  return parts.flags.some(
    (flag, place) =>
      NEEDS_NEW_WORDS.has(flag.kind) ||
      // Checked by an owner who did not say they meet it: the email must not claim it.
      (isMeetable(flag) && checked.has(flagKey(place)) && !meets.has(flag.at)),
  );
}

/**
 * "Approve & send" (decisions A20): "I checked this" on every sentence the
 * separate check holds and every one of validate's flags, as the page shows
 * them above the button, but for those only new words resolve and those
 * only the owner can answer: whether they meet a requirement. Nothing else:
 * the hard stops hold the kit until the owner acts on each.
 */
export function approveAll(parts: KitParts, decisions: ReviewDecisions): ReviewDecisions {
  const held = parts.verdicts.filter(isBlocking).map((verdict) => verdict.blockId);
  return {
    ...decisions,
    checked: held.reduce(withOne, decisions.checked),
    flagsChecked: parts.flags
      .flatMap((flag, place) =>
        NEEDS_NEW_WORDS.has(flag.kind) || isMeetable(flag) ? [] : [flagKey(place)],
      )
      .reduce(withOne, decisions.flagsChecked),
  };
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
  const meets = new Set(decisions.meets);
  return {
    sent: parts.sent,
    byEmail: parts.byEmail,
    submitted: parts.submitted,
    sending: parts.sending,
    skipped: parts.skipped,
    flags: parts.flags.filter(
      (flag, place) =>
        !flagsChecked.has(flagKey(place)) && !(isMeetable(flag) && meets.has(flag.at)),
    ),
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
