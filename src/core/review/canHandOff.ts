import type { KitFlag, KitFlagKind } from "@/core/drafting/validate";
import { type BlockVerdict, isBlocking, NEVER_WEIGHED } from "@/core/drafting/verdict";
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
 * check, and the address checks are those of the address that goes out. A
 * kit marked sent holds everything, so the same email never goes twice, and
 * so does one jobkit is sending (decisions A20), until it went or the owner
 * pressed Undo, and one the owner skipped, until the skip is taken back.
 */

export interface GateInput {
  /** Whether the owner marked the kit sent. */
  sent: boolean;
  /** Whether jobkit is sending the kit from the owner's Gmail: counting down to it, or sending. */
  sending: boolean;
  /** Whether the owner skipped the job, its kit ready (ledger spec, "Statuses"). */
  skipped: boolean;
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
  /** The checks of the address that goes out: the post's, or the one the owner typed. */
  addressChecks: readonly AddressCheck[];
  /** The ledger's duplicate matches, each with whether the owner chose to apply again. */
  duplicates: readonly { reason: string; applyAgain: boolean }[];
  /** The post's scam signals, and whether the owner chose "Continue anyway". */
  scam: { signals: readonly string[]; overridden: boolean } | null;
}

export type GateReason = { message: string } & (
  | { kind: "sent" }
  | { kind: "sending" }
  | { kind: "skipped" }
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
  overstated: "The separate check found this sentence says more than your facts show",
  unsupported: "The separate check found no fact behind this sentence",
  company: "This sentence says something about the company the post does not",
};

/** The judge's findings on a sentence, both when it also speaks for the company. */
export function judgeMessage(verdict: BlockVerdict): string {
  if (verdict.note === NEVER_WEIGHED) {
    return "The separate check never weighed this sentence: check it against your facts.";
  }
  const fact =
    verdict.verdict === "overstated"
      ? JUDGE_WORDS.overstated
      : verdict.verdict === "unsupported"
        ? JUDGE_WORDS.unsupported
        : null;
  if (fact && verdict.companyClaim) {
    return `${fact}, and it says something about the company the post does not.`;
  }
  return `${fact ?? JUDGE_WORDS.company}.`;
}

/**
 * validate's flags, most serious first: a line written for an AI tool, or a
 * reference's details, in the email; then what the email claims; then its
 * form. Flags of one kind keep validate's order.
 */
const FLAG_ORDER: readonly KitFlagKind[] = [
  "ai_instruction_followed",
  "reference_leak",
  "invalid_citation",
  "fit_missing",
  "fit_unverified",
  "missing_gap_line",
  "needs_your_line",
  "no_claims",
  "sensitive_topic_drafted",
  "subject_placeholder",
  "over_limit",
  "keyword_missing",
];

/** Whether a retyped contact may go out: an address that passes the strict check, or a number with its country. */
function passesStrict(kind: "email" | "whatsapp", value: string): boolean {
  return kind === "email" ? isStrictAddress(value) : normaliseWhatsAppNumber(value).ok;
}

/** A flag's place in FLAG_ORDER; a kind this code does not know goes last. */
export function flagRank(kind: string): number {
  const rank = FLAG_ORDER.indexOf(kind as KitFlagKind);
  return rank === -1 ? FLAG_ORDER.length : rank;
}

/**
 * The open reasons, the most serious first; none opens every outbound
 * control. A kit marked sent is held for that alone, and so is one jobkit
 * is sending, and one the owner skipped.
 */
export function canHandOff(input: GateInput): GateReason[] {
  if (input.sent) {
    return [
      {
        kind: "sent",
        message: "This email was sent, so nothing goes out from this page again.",
      },
    ];
  }
  if (input.sending) {
    return [
      {
        kind: "sending",
        message: "jobkit is sending this email from your Gmail. Press Undo to stop it.",
      },
    ];
  }
  if (input.skipped) {
    return [
      {
        kind: "skipped",
        message:
          "You skipped this job, so nothing goes out from this page. Take the skip back to apply.",
      },
    ];
  }
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
    const typed = (contact.retyped?.trim() ?? "") !== "";
    reasons.push({
      kind: "contact",
      message:
        contact.kind === "email"
          ? typed
            ? "The address you typed is not a whole address. Type it again from the post."
            : "Type the address yourself from the post."
          : typed
            ? "The number you typed is not a whole number with its country code. Type it again from the post."
            : "Type the number yourself from the post, with its country code.",
    });
  }
  for (const check of input.addressChecks) {
    if (check.blocking) reasons.push({ kind: "address_check", check, message: check.message });
  }
  for (const flag of [...input.flags].sort((a, b) => flagRank(a.kind) - flagRank(b.kind))) {
    reasons.push({ kind: "flag", flag, message: flag.message });
  }
  const checked = new Set(input.checked);
  for (const verdict of input.verdicts) {
    if (!isBlocking(verdict) || checked.has(verdict.blockId)) continue;
    reasons.push({
      kind: "judge",
      blockId: verdict.blockId,
      verdict: verdict.verdict,
      companyClaim: verdict.companyClaim,
      message: judgeMessage(verdict),
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
        message: `The post asks for ${attachment.name || "a file it does not name"}: tick it to say you will attach it in Gmail.`,
      });
    }
  }
  return reasons;
}
