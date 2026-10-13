import { type BlockVerdict, isBlocking } from "@/core/drafting/judge";
import type { KitFlag } from "@/core/drafting/validate";
import { isStrictAddress, normaliseWhatsAppNumber } from "@/core/extraction/contacts";

import type { AddressCheck } from "./addressChecks";

/**
 * The outbound gate (review spec, "The outbound gate"): one pure function,
 * the same in the browser and on the server, giving the open reasons that
 * hold back every outbound control, the Gmail handoff, each copy button,
 * "Copy all", "Open WhatsApp" and "Open application link". An empty list
 * opens them. It decides nothing about the kit's text: validate's flags
 * come already weighed against the owner's decisions, and "I checked this"
 * clears the judge's verdict on its own sentence alone. A disputed or
 * missing contact clears only with a retyped value that passes the strict
 * check.
 */

export interface GateInput {
  /** validate's flags on the kit as it stands, the owner's decisions applied: each one blocks. */
  flags: readonly KitFlag[];
  /** The judge's verdict on each sentence. */
  verdicts: readonly BlockVerdict[];
  /** Sentences the owner marked "I checked this", or rewrote and confirmed. */
  checked: readonly string[];
  /** Sentences the owner changed and has not yet confirmed. */
  unconfirmed: readonly string[];
  /** The post's required attachments, each with whether the owner ticked it. */
  attachments: readonly { name: string; ticked: boolean }[];
  /**
   * An email or WhatsApp route's contact: whether the owner must retype it,
   * because the second read disputed it or the post gave none, and what
   * they typed. Null for any other route.
   */
  contact: { kind: "email" | "whatsapp"; needsRetype: boolean; retyped: string | null } | null;
  /** The checks of the address as it stands. */
  addressChecks: readonly AddressCheck[];
  /** The ledger's duplicate matches, each with whether the owner chose to apply again. */
  duplicates: readonly { reason: string; applyAgain: boolean }[];
  /** The post's scam signals, and whether the owner chose "Continue anyway". */
  scam: { signals: readonly string[]; overridden: boolean } | null;
}

export type GateReason = { message: string } & (
  | { kind: "scam"; signals: readonly string[] }
  | { kind: "duplicate"; reason: string }
  | { kind: "contact" }
  | { kind: "address_check"; check: AddressCheck }
  | { kind: "flag"; flag: KitFlag }
  | { kind: "judge"; blockId: string; verdict: BlockVerdict["verdict"]; companyClaim: boolean }
  | { kind: "unconfirmed_edit"; blockId: string }
  | { kind: "attachment"; name: string }
);

const JUDGE_WORDS = {
  overstated: "The separate check found this sentence says more than your facts show.",
  unsupported: "The separate check found no fact behind this sentence.",
  company: "This sentence says something about the company the post does not.",
};

/** Whether a retyped contact may go out: an address that passes the strict check, or a number with its country. */
function passesStrict(kind: "email" | "whatsapp", value: string): boolean {
  return kind === "email" ? isStrictAddress(value) : normaliseWhatsAppNumber(value).ok;
}

/** The open reasons, the most serious first; none opens every outbound control. */
export function canHandOff(input: GateInput): GateReason[] {
  const reasons: GateReason[] = [];
  if (input.scam && input.scam.signals.length > 0 && !input.scam.overridden) {
    reasons.push({
      kind: "scam",
      signals: input.scam.signals,
      message:
        'This post shows signs of a scam. Choose "Continue anyway" only if you have checked it.',
    });
  }
  for (const duplicate of input.duplicates) {
    if (!duplicate.applyAgain) {
      reasons.push({
        kind: "duplicate",
        reason: duplicate.reason,
        message: `You may have applied before: ${duplicate.reason}. Choose "Apply again" to go on.`,
      });
    }
  }
  const { contact } = input;
  if (contact?.needsRetype && !passesStrict(contact.kind, contact.retyped?.trim() ?? "")) {
    reasons.push({
      kind: "contact",
      message:
        contact.kind === "email"
          ? "Type the address yourself from the post."
          : "Type the number yourself from the post, with its country code.",
    });
  }
  for (const check of input.addressChecks) {
    if (check.blocking) reasons.push({ kind: "address_check", check, message: check.message });
  }
  for (const flag of input.flags) reasons.push({ kind: "flag", flag, message: flag.message });
  const checked = new Set(input.checked);
  for (const verdict of input.verdicts) {
    if (!isBlocking(verdict) || checked.has(verdict.blockId)) continue;
    reasons.push({
      kind: "judge",
      blockId: verdict.blockId,
      verdict: verdict.verdict,
      companyClaim: verdict.companyClaim,
      message:
        verdict.verdict === "overstated"
          ? JUDGE_WORDS.overstated
          : verdict.verdict === "unsupported"
            ? JUDGE_WORDS.unsupported
            : JUDGE_WORDS.company,
    });
  }
  for (const blockId of input.unconfirmed) {
    reasons.push({
      kind: "unconfirmed_edit",
      blockId,
      message: "You changed this sentence: confirm it says only what is true.",
    });
  }
  for (const attachment of input.attachments) {
    if (!attachment.ticked) {
      reasons.push({
        kind: "attachment",
        name: attachment.name,
        message: `The post asks for ${attachment.name}: tick it once it is attached.`,
      });
    }
  }
  return reasons;
}
