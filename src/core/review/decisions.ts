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
  /** validate's flags marked "I checked this", by what each found (flagKey). */
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
  /** The owner's words for each sentence they edited, by block ID; kept with the draft. */
  edits: Record<string, string>;
  /** The edited and added sentences the owner confirmed say only what is true, by block ID. */
  confirmed: string[];
  /** The owner's own sentences, in the order added, each after the sentence it names; kept with the draft. */
  added: AddedSentence[];
  /** The drafted sentences the owner deleted, by block ID; kept with the draft. */
  deleted: string[];
}

/** A sentence the owner added: "N1" and on, after the sentence `after` names, or first (""). */
export interface AddedSentence {
  id: string;
  after: string;
  text: string;
}

export const NO_DECISIONS: ReviewDecisions = {
  checked: [],
  flagsChecked: [],
  retyped: null,
  attached: [],
  continueAnyway: false,
  lookups: [],
  meets: [],
  edits: {},
  confirmed: [],
  added: [],
  deleted: [],
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
  // Kept from before the block editor: none.
  edits: z.record(z.string(), z.string()).default({}),
  confirmed: z.array(z.string()).default([]),
  // Kept from before sentences could be added or deleted: none.
  added: z.array(z.object({ id: z.string(), after: z.string(), text: z.string() })).default([]),
  deleted: z.array(z.string()).default([]),
});

/** The most characters an edited or added sentence holds. */
export const MAX_SENTENCE = 1500;

/** The most sentences the owner adds to one draft. */
export const MAX_ADDED = 30;

/**
 * A flag's name (flagKey): its kind, its place, and eight hex digits of its
 * words; or its place among the kit's flags ("F2"), as a page drawn before
 * flags were named posts it, which no flag has now: the decision is refused
 * as not in the kit, and the page drawn again.
 */
const FLAG_NAME = /^(?:[a-z_]{1,40}@[^@~\s]{1,40}~[0-9a-f]{8}|F\d{1,4})$/;

/** One decision, as the page posts it. A typed contact fits RFC 5321's 254 characters with room. */
export const reviewActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("check"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("uncheck"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("check_flag"), flag: z.string().regex(FLAG_NAME) }),
  z.strictObject({ kind: z.literal("uncheck_flag"), flag: z.string().regex(FLAG_NAME) }),
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
  // A sentence in the owner's words: its new text, never empty, as long as a sentence runs.
  z.strictObject({
    kind: z.literal("edit"),
    blockId: z.string().min(1).max(20),
    text: z.string().trim().min(1).max(MAX_SENTENCE),
  }),
  z.strictObject({ kind: z.literal("revert"), blockId: z.string().min(1).max(20) }),
  z.strictObject({ kind: z.literal("confirm"), blockId: z.string().min(1).max(20) }),
  // A sentence in the owner's words, after the sentence named, or first ("").
  z.strictObject({
    kind: z.literal("add"),
    after: z.string().max(20),
    text: z.string().trim().min(1).max(MAX_SENTENCE),
  }),
  z.strictObject({ kind: z.literal("delete"), blockId: z.string().min(1).max(20) }),
]);

export type ReviewAction = z.infer<typeof reviewActionSchema>;

/**
 * A flag's name among the kit's, by what it found: its kind, its place, and
 * a short hash of its words ("over_limit@body~1a2b3c4d"), so it keeps its
 * name when validate runs again after an edit, and two at one place, as two
 * lines aimed at AI the email repeats, are told apart. A finding whose
 * words change is a new flag, which an earlier "I checked this" did not see:
 * one whose words count, as an email's length does, is named again when the
 * count changes, and validate's wording of a finding, changed, names every
 * such flag anew, so the owner checks each again. A flag at a sentence
 * keeps its name through the sentence's edits, so an edit takes back the
 * checks on its flags (decide).
 */
export function flagKey(flag: Pick<KitFlag, "kind" | "at" | "message">): string {
  return `${flag.kind}@${flag.at}~${shortHash(flag.message)}`;
}

/** FNV-1a over a string's UTF-16 code units, as eight hex digits: short, and the same in the browser. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Decisions kept when flags were named by their place among drafting's
 * ("F2", the second of the kit's flags as drafting kept them), named as
 * now, by what that flag found; a place the kit has no flag at is dropped.
 */
export function withFlagNames(
  decisions: ReviewDecisions,
  flags: readonly KitFlag[],
): ReviewDecisions {
  const named = decisions.flagsChecked.flatMap((key) => {
    const place = /^F(\d{1,4})$/.exec(key);
    if (!place) return [key];
    const flag = flags[Number(place[1]) - 1];
    return flag ? [flagKey(flag)] : [];
  });
  return { ...decisions, flagsChecked: [...new Set(named)] };
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
/** A record without one of its keys. */
const withoutKey = (record: Readonly<Record<string, string>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([each]) => each !== key));
/** The flags' names but those at one sentence, whose "I checked this" weighed other words. */
const notAt = (names: readonly string[], blockId: string) =>
  names.filter((name) => name.slice(name.indexOf("@") + 1, name.lastIndexOf("~")) !== blockId);
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
    // An edit needs the owner's confirmation again, as new words.
    // New words for a sentence, the owner's or drafting's again: confirmed and checked anew, but the
    // separate check's verdict, which weighed the drafted words and stands aside meanwhile.
    case "edit": {
      const text = action.text.trim();
      const anew = {
        ...decisions,
        confirmed: without(decisions.confirmed, action.blockId),
        flagsChecked: notAt(decisions.flagsChecked, action.blockId),
      };
      return isAdded(decisions, action.blockId)
        ? {
            ...anew,
            added: decisions.added.map((each) =>
              each.id === action.blockId ? { ...each, text } : each,
            ),
          }
        : { ...anew, edits: { ...decisions.edits, [action.blockId]: text } };
    }
    // Drafting's words again, for a sentence edited or deleted.
    case "revert":
      return {
        ...decisions,
        edits: withoutKey(decisions.edits, action.blockId),
        deleted: without(decisions.deleted, action.blockId),
        confirmed: without(decisions.confirmed, action.blockId),
        flagsChecked: notAt(decisions.flagsChecked, action.blockId),
      };
    case "add": {
      // Named after the highest: "N1", "N2" and on.
      const highest = Math.max(
        0,
        ...decisions.added.map((each) => Number(/^N(\d+)$/.exec(each.id)?.[1] ?? 0)),
      );
      const sentence = { id: `N${highest + 1}`, after: action.after, text: action.text.trim() };
      return { ...decisions, added: [...decisions.added, sentence] };
    }
    case "delete": {
      const cleared = {
        ...decisions,
        confirmed: without(decisions.confirmed, action.blockId),
        flagsChecked: notAt(decisions.flagsChecked, action.blockId),
      };
      const gone = decisions.added.find((each) => each.id === action.blockId);
      // An added sentence goes outright, and one added after it takes its place.
      if (gone) {
        return {
          ...cleared,
          added: decisions.added
            .filter((each) => each !== gone)
            .map((each) => (each.after === gone.id ? { ...each, after: gone.after } : each)),
        };
      }
      return {
        ...cleared,
        edits: withoutKey(decisions.edits, action.blockId),
        deleted: withOne(decisions.deleted, action.blockId),
      };
    }
    case "confirm":
      return { ...decisions, confirmed: withOne(decisions.confirmed, action.blockId) };
  }
}

/** Whether the owner edited a sentence: their words replace it, and its verdict with them. */
export function isEdited(decisions: Pick<ReviewDecisions, "edits">, blockId: string): boolean {
  return Object.hasOwn(decisions.edits, blockId);
}

/** Whether a sentence is one the owner added. */
export function isAdded(decisions: Pick<ReviewDecisions, "added">, blockId: string): boolean {
  return decisions.added.some((each) => each.id === blockId);
}

/** Whether the owner deleted a drafted sentence: it is not in the email, and its verdict holds nothing. */
export function isDeleted(decisions: Pick<ReviewDecisions, "deleted">, blockId: string): boolean {
  return decisions.deleted.includes(blockId);
}

/** Whether a sentence of the email is in the owner's words, edited or added, for them to confirm. */
export function isOwners(
  decisions: Pick<ReviewDecisions, "edits" | "added" | "deleted">,
  blockId: string,
): boolean {
  return (
    (isEdited(decisions, blockId) || isAdded(decisions, blockId)) && !isDeleted(decisions, blockId)
  );
}

/** What the gate reads from a kit, besides the owner's decisions. */
export interface KitParts {
  /** The kit's sentences by ID: the draft's, those the owner deleted included, then those they added. */
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
  /**
   * The chosen role's must-have requirements, by ID: one only the owner can
   * confirm, which they checked without saying they meet it, needs new
   * words, a line saying they do not meet it.
   */
  mustHaves?: readonly string[];
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
  parts: Pick<KitParts, "flags" | "mustHaves">,
  decisions: Pick<ReviewDecisions, "flagsChecked" | "meets"> = NO_DECISIONS,
): boolean {
  const checked = new Set(decisions.flagsChecked);
  const meets = new Set(decisions.meets);
  const musts = new Set(parts.mustHaves ?? []);
  return parts.flags.some(
    (flag) =>
      NEEDS_NEW_WORDS.has(flag.kind) ||
      // A must-have checked by an owner who did not say they meet it: the email must not claim it,
      // and needs a line saying so.
      (isMeetable(flag) && musts.has(flag.at) && checked.has(flagKey(flag)) && !meets.has(flag.at)),
  );
}

/** One mark Approve & send makes: a sentence the separate check holds, or one of validate's flags. */
export type Approval = { key: string; blockId: string } | { key: string; flag: KitFlag };

/**
 * What Approve & send marks "I checked this" on, of what the gate now
 * holds: the separate check's sentences ("sentence:S2"), then validate's
 * flags ("flag:" and its name), but those only new words resolve and those
 * only the owner can answer, each with the sentence or flag it marks, for
 * the confirmation to list: every flag, though two share a name.
 */
export function approvals(parts: KitParts, decisions: ReviewDecisions): Approval[] {
  const blocks = new Set(parts.blocks);
  const checked = new Set(decisions.checked);
  const flagsChecked = new Set(decisions.flagsChecked);
  const held = parts.verdicts
    .filter(
      (verdict) =>
        isBlocking(verdict) &&
        blocks.has(verdict.blockId) &&
        !checked.has(verdict.blockId) &&
        !isEdited(decisions, verdict.blockId) &&
        !isDeleted(decisions, verdict.blockId),
    )
    .map((verdict) => verdict.blockId);
  const sentences = [...new Set(held)].map((blockId): Approval => ({
    key: `sentence:${blockId}`,
    blockId,
  }));
  const flags = parts.flags.flatMap((flag): Approval[] => {
    const key = flagKey(flag);
    return flagsChecked.has(key) || NEEDS_NEW_WORDS.has(flag.kind) || isMeetable(flag)
      ? []
      : [{ key: `flag:${key}`, flag }];
  });
  return [...sentences, ...flags];
}

/** The names of what Approve & send marks (approvals), each once. */
export function approvable(parts: KitParts, decisions: ReviewDecisions): string[] {
  return [...new Set(approvals(parts, decisions).map((each) => each.key))];
}

/**
 * What Approve & send marks (approvable) as one short key, its names in
 * order: the page's press gives the key of what its confirmation listed,
 * and the server sends only while it would mark what has that key, so a
 * press never marks what its page did not list, as when a decision was
 * taken back on the other device after the page was drawn. A key, not the
 * names, so a press is as short with sixty marks as with one.
 */
export function approvalsKey(parts: KitParts, decisions: ReviewDecisions): string {
  return shortHash(approvable(parts, decisions).sort().join("\n"));
}

/**
 * "Approve & send" (decisions A20): "I checked this" on every sentence the
 * separate check holds and every one of validate's flags, as the page shows
 * them above the button, but for those only new words resolve and those
 * only the owner can answer: whether they meet a requirement. Nothing else:
 * the hard stops hold the kit until the owner acts on each.
 */
export function approveAll(parts: KitParts, decisions: ReviewDecisions): ReviewDecisions {
  const held = parts.verdicts
    .filter(
      (verdict) =>
        isBlocking(verdict) &&
        !isEdited(decisions, verdict.blockId) &&
        !isDeleted(decisions, verdict.blockId),
    )
    .map((verdict) => verdict.blockId);
  return {
    ...decisions,
    checked: held.reduce(withOne, decisions.checked),
    flagsChecked: parts.flags
      .flatMap((flag) =>
        NEEDS_NEW_WORDS.has(flag.kind) || isMeetable(flag) ? [] : [flagKey(flag)],
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
      (flag) => !flagsChecked.has(flagKey(flag)) && !(isMeetable(flag) && meets.has(flag.at)),
    ),
    // A verdict on words the owner replaced or deleted holds nothing: their words hold the kit
    // until confirmed.
    verdicts: parts.verdicts.filter(
      (verdict) =>
        blocks.has(verdict.blockId) &&
        !isEdited(decisions, verdict.blockId) &&
        !isDeleted(decisions, verdict.blockId),
    ),
    checked: decisions.checked.filter((id) => blocks.has(id)),
    unconfirmed: parts.blocks.filter(
      (id) => isOwners(decisions, id) && !decisions.confirmed.includes(id),
    ),
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
