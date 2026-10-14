import { describe, expect, it } from "vitest";

import { ADDRESS_CHECKS_VERSION, type AddressCheck } from "./addressChecks";
import { canHandOff } from "./canHandOff";
import {
  approveAll,
  decide,
  flagKey,
  gateInputOf,
  keptLookup,
  type KitParts,
  NO_DECISIONS,
  reviewActionSchema,
  type ReviewDecisions,
} from "./decisions";

/* The owner's decisions on a kit, which the outbound gate reads: review AC1 and AC4. */

const FLAG = {
  kind: "fit_unverified" as const,
  at: "R2",
  message: "Only you can confirm you meet this requirement.",
};

const PARTS: KitParts = {
  blocks: ["S1", "S2", "S3"],
  flags: [FLAG],
  verdicts: [
    { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
    { blockId: "S2", verdict: "overstated", companyClaim: false, note: "Five years is more." },
  ],
  attachments: [{ id: "A2", name: "Portfolio link" }],
  contact: { kind: "email", needsRetype: true },
  addressChecks: [],
  scamSignals: ["asks for a fee"],
  duplicates: [{ reason: "You applied to this company and role before", covered: false }],
  sent: false,
  sending: false,
};

const MAIL_HOST: AddressCheck = {
  kind: "mail_host",
  blocking: true,
  message: "This address's domain has no mail server. Check the address in the post.",
};

describe("decide", () => {
  it("records each decision, and the same one twice changes nothing more", () => {
    let decisions: ReviewDecisions = NO_DECISIONS;
    for (const action of [
      { kind: "check", blockId: "S2" },
      { kind: "check", blockId: "S2" },
      { kind: "check_flag", flag: "F1" },
      { kind: "attach", id: "A2", ticked: true },
      { kind: "continue_anyway" },
    ] as const) {
      decisions = decide(decisions, action);
    }
    decisions = decide(decisions, { kind: "retype", value: " jobs@example.com " }, []);

    expect(decisions).toEqual({
      checked: ["S2"],
      flagsChecked: ["F1"],
      retyped: { value: "jobs@example.com", checks: [] },
      attached: ["A2"],
      continueAnyway: true,
      lookups: [{ address: "jobs@example.com", version: ADDRESS_CHECKS_VERSION, checks: [] }],
    });
    expect(decide(decisions, { kind: "uncheck", blockId: "S2" }).checked).toEqual([]);
    expect(decide(decisions, { kind: "uncheck_flag", flag: "F1" }).flagsChecked).toEqual([]);
    expect(decide(decisions, { kind: "attach", id: "A2", ticked: false }).attached).toEqual([]);
    expect(decide(decisions, { kind: "retype", value: "  " }).retyped).toBeNull();
  });

  it("refuses an action it does not know, or one too long to be a decision", () => {
    expect(reviewActionSchema.safeParse({ kind: "send" }).success).toBe(false);
    expect(reviewActionSchema.safeParse({ kind: "retype", value: "x".repeat(400) }).success).toBe(
      false,
    );
    expect(reviewActionSchema.safeParse({ kind: "check", blockId: "S1" }).success).toBe(true);
    // An attachment is ticked by its place in the post's list, whatever its name.
    expect(reviewActionSchema.safeParse({ kind: "attach", id: "A1", ticked: true }).success).toBe(
      true,
    );
  });

  it("names a flag by its place among the kit's, so two alike are told apart", () => {
    expect(flagKey(0)).toBe("F1");
    expect(reviewActionSchema.safeParse({ kind: "check_flag", flag: "F12" }).success).toBe(true);
    expect(
      reviewActionSchema.safeParse({ kind: "check_flag", flag: "fit_unverified:R2" }).success,
    ).toBe(false);
  });

  it("keeps the first checks found for each address typed, so a lookup that fails later changes nothing", () => {
    const blocking: AddressCheck = {
      kind: "mail_host",
      blocking: true,
      message: "No mail server.",
    };
    let decisions = decide(NO_DECISIONS, { kind: "retype", value: "jobs@deadco.example" }, [
      blocking,
    ]);
    decisions = decide(decisions, { kind: "retype", value: "jobs@other.example" }, []);

    expect(keptLookup(decisions, "jobs@deadco.example")).toEqual([blocking]);
    expect(keptLookup(decisions, "jobs@unknown.example")).toBeNull();
    // Typed again, with what a failed lookup would give: the first finding stands.
    decisions = decide(decisions, { kind: "retype", value: "jobs@deadco.example" }, []);
    expect(decisions.lookups).toHaveLength(2);
    expect(keptLookup(decisions, "jobs@deadco.example")).toEqual([blocking]);
  });
});

describe("gateInputOf", () => {
  it("holds every control back until each open reason is resolved, then opens them", () => {
    const open = canHandOff(gateInputOf(PARTS, NO_DECISIONS)).map((reason) => reason.kind);
    expect(open).toEqual(["scam", "duplicate", "contact", "flag", "judge", "attachment"]);

    const decided = [
      { kind: "continue_anyway" },
      { kind: "check", blockId: "S2" },
      { kind: "check_flag", flag: "F1" },
      { kind: "attach", id: "A2", ticked: true },
    ] as const;
    const decisions = decide(
      decided.reduce<ReviewDecisions>((each, action) => decide(each, action), NO_DECISIONS),
      { kind: "retype", value: "jobs@example.com" },
      [],
    );
    const covered = { ...PARTS, duplicates: [{ ...PARTS.duplicates[0]!, covered: true }] };

    expect(canHandOff(gateInputOf(covered, decisions))).toEqual([]);
    expect(canHandOff(gateInputOf({ ...covered, sent: true }, decisions))).toEqual([
      expect.objectContaining({ kind: "sent" }),
    ]);
  });

  it("weighs the address that goes out: the post's, or the one typed, with its own checks", () => {
    // The post's address has no mail server, so the owner must type one.
    const parts: KitParts = {
      ...PARTS,
      flags: [],
      verdicts: [],
      attachments: [],
      scamSignals: [],
      duplicates: [],
      addressChecks: [MAIL_HOST],
    };
    const kinds = (decisions: ReviewDecisions) =>
      canHandOff(gateInputOf(parts, decisions)).map((reason) => reason.kind);

    // Nothing typed yet: the contact is the reason, not the post's checks.
    expect(kinds(NO_DECISIONS)).toEqual(["contact"]);
    // Typed, and its own checks found a mail server: nothing holds it.
    expect(kinds(decide(NO_DECISIONS, { kind: "retype", value: "hr@acme.com" }, []))).toEqual([]);
    // Typed, and its own checks found none: that holds it.
    expect(
      kinds(decide(NO_DECISIONS, { kind: "retype", value: "hr@acme.co" }, [MAIL_HOST])),
    ).toEqual(["address_check"]);
    // Typed, but never checked: it holds as not checked.
    expect(kinds(decide(NO_DECISIONS, { kind: "retype", value: "hr@acme.com" }))).toEqual([
      "address_check",
    ]);
    // The post's address, undisputed, is held by its own checks.
    expect(
      canHandOff(
        gateInputOf({ ...parts, contact: { kind: "email", needsRetype: false } }, NO_DECISIONS),
      ).map((reason) => reason.kind),
    ).toEqual(["address_check"]);
  });

  it("forgets decisions the kit no longer has a place for", () => {
    const decisions: ReviewDecisions = {
      checked: ["S9"],
      flagsChecked: ["F9"],
      retyped: null,
      attached: ["A9"],
      continueAnyway: false,
      lookups: [],
    };

    const input = gateInputOf({ ...PARTS, blocks: ["S1"] }, decisions);

    expect(input.checked).toEqual([]);
    expect(input.flags).toEqual([FLAG]);
    expect(input.attachments).toEqual([{ name: "Portfolio link", ticked: false }]);
    // A verdict on a sentence no longer in the kit holds nothing.
    expect(input.verdicts.map((verdict) => verdict.blockId)).toEqual(["S1"]);
  });
});

describe("approveAll", () => {
  it('marks "I checked this" on every flagged sentence and flag, and no other decision', () => {
    const approved = approveAll(PARTS, decide(NO_DECISIONS, { kind: "check", blockId: "S2" }));

    expect(approved).toEqual({ ...NO_DECISIONS, checked: ["S2"], flagsChecked: ["F1"] });
    // The hard stops still hold the kit: the scam warning, the possible repeat, the contact, the
    // attachment.
    expect(canHandOff(gateInputOf(PARTS, approved)).map((reason) => reason.kind)).toEqual([
      "scam",
      "duplicate",
      "contact",
      "attachment",
    ]);
  });

  it("checks only the sentences the gate holds: one about the company, not a supported one", () => {
    const parts: KitParts = {
      ...PARTS,
      flags: [],
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "S3", verdict: "supported", companyClaim: true, note: "" },
      ],
    };

    expect(approveAll(parts, NO_DECISIONS).checked).toEqual(["S3"]);
  });
});
