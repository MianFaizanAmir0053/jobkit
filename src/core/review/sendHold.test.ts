import { describe, expect, it } from "vitest";

import type { KitFlag } from "@/core/drafting/validate";

import { canHandOff } from "./canHandOff";
import {
  flagKey,
  gateInputOf,
  type KitParts,
  NO_DECISIONS,
  type ReviewDecisions,
} from "./decisions";
import { type SendHold, sendHoldOf } from "./sendHold";

/* What holds "Approve & send" while the gate holds the kit for a reason its press does not settle: review AC2. */

/** A must-have only the owner can confirm they meet. */
const MEETABLE: KitFlag = {
  kind: "fit_unverified",
  at: "R2",
  message: "Only you can confirm you meet this requirement.",
};
const OWN_LINE: KitFlag = {
  kind: "needs_your_line",
  at: "S2",
  message: "Write this line yourself.",
};
const REPEAT = { reason: "You applied to this company and role before", covered: false };

const CLEAR: KitParts = {
  blocks: ["S1", "S2"],
  flags: [],
  verdicts: [
    { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
    { blockId: "S2", verdict: "supported", companyClaim: false, note: "" },
  ],
  attachments: [],
  contact: { kind: "email", needsRetype: false },
  addressChecks: [],
  scamSignals: [],
  duplicates: [],
  sent: false,
  byEmail: true,
  sending: false,
  skipped: false,
  mustHaves: ["R2"],
};

/** The hold, with the gate as the job view gives it for the kit and the decisions. */
const holdOf = (
  parts: Partial<KitParts>,
  decisions: Partial<ReviewDecisions> = {},
): SendHold["kind"] | null => {
  const kit = { ...CLEAR, ...parts };
  const made = { ...NO_DECISIONS, ...decisions };
  return sendHoldOf(kit, made, canHandOff(gateInputOf(kit, made)))?.kind ?? null;
};

describe("sendHoldOf", () => {
  it.each<[string, Partial<KitParts>]>([
    ["nothing open", {}],
    [
      "a sentence the separate check holds",
      { verdicts: [{ blockId: "S2", verdict: "overstated", companyClaim: false, note: "" }] },
    ],
    [
      "a flag of validate's it marks, as a missing keyword",
      { flags: [{ kind: "keyword_missing", at: "body", message: "The keyword is missing." }] },
    ],
    ["a send counting down, which says so itself", { sending: true }],
  ])("leaves the press open with %s", (_, parts) => {
    expect(holdOf(parts)).toBeNull();
  });

  it.each<[string, Partial<KitParts>, Partial<ReviewDecisions>, SendHold["kind"]]>([
    [
      "a file besides the CV, though the owner ticked it",
      { attachments: [{ id: "A2", name: "Portfolio" }] },
      { attached: ["A2"] },
      "attachment",
    ],
    ["a line only the owner can write", { flags: [OWN_LINE] }, {}, "words"],
    [
      "a must-have the owner checked without saying they meet it",
      { flags: [MEETABLE] },
      { flagsChecked: [flagKey(MEETABLE)] },
      "words",
    ],
    ["a requirement only the owner can say they meet", { flags: [MEETABLE] }, {}, "meets"],
    ["a possible repeat", { duplicates: [REPEAT] }, {}, "others"],
    ["a scam warning", { scamSignals: ["asks for a fee"] }, {}, "others"],
    [
      "an address not yet confirmed",
      { contact: { kind: "email", needsRetype: true } },
      {},
      "others",
    ],
    [
      "an address that takes no mail",
      {
        addressChecks: [
          { kind: "mail_host", blocking: true, message: "This address's domain takes no mail." },
        ],
      },
      {},
      "others",
    ],
    [
      "a changed sentence not yet confirmed",
      {},
      { edits: { S1: "I have built React applications for five years." } },
      "others",
    ],
  ])("holds the press for %s", (_, parts, decisions, expected) => {
    expect(holdOf(parts, decisions)).toBe(expected);
  });

  it("says first what the owner must do in Gmail, then their word on a requirement, then the rest", () => {
    const all: Partial<KitParts> = {
      attachments: [{ id: "A2", name: "Portfolio" }],
      flags: [MEETABLE, OWN_LINE],
      duplicates: [REPEAT],
    };

    expect(holdOf(all)).toBe("attachment");
    expect(holdOf({ ...all, attachments: [] })).toBe("words");
    expect(holdOf({ ...all, attachments: [], flags: [MEETABLE] })).toBe("meets");
    // The owner says they meet it: only the possible repeat is left.
    expect(holdOf({ ...all, attachments: [], flags: [MEETABLE] }, { meets: ["R2"] })).toBe(
      "others",
    );
  });
});
