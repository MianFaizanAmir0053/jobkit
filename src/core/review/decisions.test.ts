import { describe, expect, it } from "vitest";

import { canHandOff } from "./canHandOff";
import {
  decide,
  gateInputOf,
  type KitParts,
  NO_DECISIONS,
  reviewActionSchema,
  type ReviewDecisions,
} from "./decisions";

/* The owner's decisions on a kit, which the outbound gate reads: review AC1 and AC4. */

const PARTS: KitParts = {
  blocks: ["S1", "S2", "S3"],
  flags: [],
  verdicts: [
    { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
    { blockId: "S2", verdict: "overstated", companyClaim: false, note: "Five years is more." },
  ],
  attachments: ["Portfolio link"],
  contact: { kind: "email", needsRetype: true },
  addressChecks: [],
  scamSignals: ["asks for a fee"],
  duplicates: [{ reason: "You applied to this company and role before", covered: false }],
};

describe("decide", () => {
  it("records each decision, and the same one twice changes nothing more", () => {
    let decisions: ReviewDecisions = NO_DECISIONS;
    for (const action of [
      { kind: "check", blockId: "S2" },
      { kind: "check", blockId: "S2" },
      { kind: "retype", value: " jobs@example.com " },
      { kind: "attach", name: "Portfolio link", ticked: true },
      { kind: "continue_anyway" },
    ] as const) {
      decisions = decide(decisions, action);
    }

    expect(decisions).toEqual({
      checked: ["S2"],
      retyped: "jobs@example.com",
      attached: ["Portfolio link"],
      continueAnyway: true,
    });
    expect(decide(decisions, { kind: "uncheck", blockId: "S2" }).checked).toEqual([]);
    expect(
      decide(decisions, { kind: "attach", name: "Portfolio link", ticked: false }).attached,
    ).toEqual([]);
  });

  it("refuses an action it does not know, or one too long to be a decision", () => {
    expect(reviewActionSchema.safeParse({ kind: "send" }).success).toBe(false);
    expect(reviewActionSchema.safeParse({ kind: "retype", value: "x".repeat(400) }).success).toBe(
      false,
    );
    expect(reviewActionSchema.safeParse({ kind: "check", blockId: "S1" }).success).toBe(true);
  });
});

describe("gateInputOf", () => {
  it("holds every control back until each open reason is resolved, then opens them", () => {
    const open = canHandOff(gateInputOf(PARTS, NO_DECISIONS)).map((reason) => reason.kind);
    expect(open).toEqual(["scam", "duplicate", "contact", "judge", "attachment"]);

    const decided = [
      { kind: "continue_anyway" },
      { kind: "retype", value: "jobs@example.com" },
      { kind: "check", blockId: "S2" },
      { kind: "attach", name: "Portfolio link", ticked: true },
    ] as const;
    const decisions = decided.reduce<ReviewDecisions>(decide, NO_DECISIONS);
    const covered = { ...PARTS, duplicates: [{ ...PARTS.duplicates[0]!, covered: true }] };

    expect(canHandOff(gateInputOf(covered, decisions))).toEqual([]);
  });

  it("forgets decisions the kit no longer has a place for", () => {
    const decisions: ReviewDecisions = {
      checked: ["S9"],
      retyped: null,
      attached: ["A cover letter"],
      continueAnyway: false,
    };

    const input = gateInputOf({ ...PARTS, blocks: ["S1"] }, decisions);

    expect(input.checked).toEqual([]);
    expect(input.attachments).toEqual([{ name: "Portfolio link", ticked: false }]);
  });
});
