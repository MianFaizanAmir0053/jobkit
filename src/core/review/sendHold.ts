import type { GateReason } from "./canHandOff";
import { isMeetable, type KitParts, needsNewWords, type ReviewDecisions } from "./decisions";

/**
 * What holds "Approve & send" (decisions A20) back while the gate holds the
 * kit for a reason its press does not settle (review AC2): the page disables
 * the button and says why beside it, as scheduleSend refuses the press. The
 * press marks "I checked this" on the separate check's sentences and on
 * validate's flags, and settles nothing else. In the order the owner meets
 * them: a post that asks for a file besides the CV, which jobkit cannot
 * attach, ticked or not; words that must change first, which jobkit cannot
 * change; a requirement only the owner can say they meet; then any other
 * reason the gate lists, as a possible repeat or an address not confirmed.
 */
export interface SendHold {
  kind: "attachment" | "words" | "meets" | "others";
  message: string;
}

const HOLD_MESSAGES: Readonly<Record<SendHold["kind"], string>> = {
  attachment:
    "This post asks for a file besides your CV, which jobkit cannot attach: send it yourself with Open in Gmail, and attach the file there.",
  words:
    "Some of this email's words must change before it goes: change them above where you can, or send it yourself with Open in Gmail and change them there.",
  meets:
    "Only you can say whether you meet a requirement above: tick it under How you fit, or say you will fix the email, first.",
  others:
    "Approve & send marks the sentences and flags above as checked, but the other reasons listed need you first.",
};

const hold = (kind: SendHold["kind"]): SendHold => ({ kind, message: HOLD_MESSAGES[kind] });

/**
 * What holds Approve & send for the kit and the owner's decisions, given the
 * gate's open reasons as the server last found them; null when the press
 * may go. While jobkit sends the email, its countdown says so instead.
 */
export function sendHoldOf(
  parts: Pick<KitParts, "attachments" | "flags" | "mustHaves" | "ownLines">,
  decisions: Pick<ReviewDecisions, "flagsChecked" | "meets">,
  gate: readonly GateReason[],
): SendHold | null {
  if (parts.attachments.length > 0) return hold("attachment");
  if (needsNewWords(parts, decisions)) return hold("words");
  const open = gate.filter((reason) => reason.kind !== "sending");
  if (open.some((reason) => reason.kind === "flag" && isMeetable(reason.flag))) {
    return hold("meets");
  }
  if (open.some((reason) => reason.kind !== "judge" && reason.kind !== "flag")) {
    return hold("others");
  }
  return null;
}
