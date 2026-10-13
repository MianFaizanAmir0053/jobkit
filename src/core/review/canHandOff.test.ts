import { describe, expect, it } from "vitest";

import type { BlockVerdict } from "@/core/drafting/judge";
import type { KitFlag } from "@/core/drafting/validate";

import type { AddressCheck } from "./addressChecks";
import { canHandOff, type GateInput } from "./canHandOff";

/* The outbound gate: review AC1, and AC4's clauses on "I checked this" and the retyped contact. */

const CLEAR: GateInput = {
  sent: false,
  flags: [],
  verdicts: [],
  checked: [],
  unconfirmed: [],
  attachments: [],
  contact: null,
  addressChecks: [],
  duplicates: [],
  scam: null,
};

const verdict = (blockId: string, overrides: Partial<BlockVerdict> = {}): BlockVerdict => ({
  blockId,
  verdict: "supported",
  companyClaim: false,
  note: "",
  ...overrides,
});

const FLAG: KitFlag = {
  kind: "over_limit",
  at: "body",
  message: "The email runs past the post's word limit.",
};
const BLOCKING_CHECK: AddressCheck = {
  kind: "mail_host",
  blocking: true,
  message: "This address's domain has no mail server. Check the address in the post.",
};

const kinds = (input: GateInput) => canHandOff(input).map((reason) => reason.kind);

describe("canHandOff", () => {
  it("opens the controls when nothing is open", () => {
    expect(canHandOff(CLEAR)).toEqual([]);
  });

  it.each<[string, Partial<GateInput>, Partial<GateInput>]>([
    ["an unresolved flag from validate", { flags: [FLAG] }, { flags: [] }],
    [
      "an overstated sentence without its tick",
      { verdicts: [verdict("S2", { verdict: "overstated" })] },
      { verdicts: [verdict("S2", { verdict: "overstated" })], checked: ["S2"] },
    ],
    [
      "an unsupported sentence without its tick",
      { verdicts: [verdict("S3", { verdict: "unsupported" })] },
      { verdicts: [verdict("S3", { verdict: "unsupported" })], checked: ["S3"] },
    ],
    [
      "a claim about the company without its tick",
      { verdicts: [verdict("S4", { companyClaim: true })] },
      { verdicts: [verdict("S4", { companyClaim: true })], checked: ["S4"] },
    ],
    ["a changed sentence not yet confirmed", { unconfirmed: ["S5"] }, { unconfirmed: [] }],
    [
      "a required attachment without its tick",
      { attachments: [{ name: "Portfolio", ticked: false }] },
      { attachments: [{ name: "Portfolio", ticked: true }] },
    ],
    [
      "a disputed address not yet retyped",
      { contact: { kind: "email", needsRetype: true, retyped: null } },
      { contact: { kind: "email", needsRetype: true, retyped: "jobs@example.com" } },
    ],
    [
      "a disputed number not yet retyped",
      { contact: { kind: "whatsapp", needsRetype: true, retyped: null } },
      { contact: { kind: "whatsapp", needsRetype: true, retyped: "+92 300 0000000" } },
    ],
    ["a blocking address check", { addressChecks: [BLOCKING_CHECK] }, { addressChecks: [] }],
    [
      "a duplicate without apply again",
      { duplicates: [{ reason: "the same company and role", applyAgain: false }] },
      { duplicates: [{ reason: "the same company and role", applyAgain: true }] },
    ],
    [
      "a scam signal without the override",
      { scam: { signals: ["asks for a fee"], overridden: false } },
      { scam: { signals: ["asks for a fee"], overridden: true } },
    ],
    ["a kit marked sent", { sent: true }, { sent: false }],
  ])("blocks on %s alone, and clears when its resolution is recorded", (_, open, resolved) => {
    expect(canHandOff({ ...CLEAR, ...open })).toHaveLength(1);
    expect(canHandOff({ ...CLEAR, ...resolved })).toEqual([]);
  });

  it('clears with "I checked this" only its own sentence', () => {
    const verdicts = [
      verdict("S1", { verdict: "overstated" }),
      verdict("S2", { verdict: "unsupported" }),
      verdict("S3"),
    ];

    const open = canHandOff({ ...CLEAR, verdicts, checked: ["S1"] });

    expect(open).toEqual([
      expect.objectContaining({ kind: "judge", blockId: "S2", verdict: "unsupported" }),
    ]);
  });

  it("clears a disputed contact only with a retyped value that passes the strict check", () => {
    const retyped = (value: string, kind: "email" | "whatsapp" = "email") =>
      kinds({ ...CLEAR, contact: { kind, needsRetype: true, retyped: value } });

    expect(retyped("jobs@example.com")).toEqual([]);
    expect(retyped("jobs@example.com?bcc=x@evil.example")).toEqual(["contact"]);
    expect(retyped(" ")).toEqual(["contact"]);
    expect(retyped("202 555 0143", "whatsapp")).toEqual(["contact"]);
    expect(retyped("0300 0000000", "whatsapp")).toEqual([]);
    // An undisputed contact needs nothing typed.
    expect(
      kinds({ ...CLEAR, contact: { kind: "email", needsRetype: false, retyped: null } }),
    ).toEqual([]);
  });

  it("says when a typed contact does not pass, rather than asking for it again", () => {
    const [typedBad] = canHandOff({
      ...CLEAR,
      contact: { kind: "email", needsRetype: true, retyped: "hr@acme" },
    });
    const [none] = canHandOff({
      ...CLEAR,
      contact: { kind: "email", needsRetype: true, retyped: null },
    });

    expect(typedBad?.message).toMatch(/you typed/i);
    expect(none?.message).not.toMatch(/you typed/i);
  });

  it("puts the most serious flags first: a line written for an AI tool, a reference leaked", () => {
    const flags: KitFlag[] = [
      FLAG,
      { kind: "keyword_missing", at: "body", message: "The post's keyword is missing." },
      { kind: "ai_instruction_followed", at: "S2", message: "A line aimed at AI was followed." },
      { kind: "reference_leak", at: "S3", message: "A reference's name is in the email." },
    ];

    const open = canHandOff({ ...CLEAR, flags });

    expect(open.map((reason) => (reason.kind === "flag" ? reason.flag.kind : reason.kind))).toEqual(
      ["ai_instruction_followed", "reference_leak", "over_limit", "keyword_missing"],
    );
  });

  it("names both findings on a sentence that overstates and claims something of the company", () => {
    const [reason] = canHandOff({
      ...CLEAR,
      verdicts: [verdict("S2", { verdict: "overstated", companyClaim: true })],
    });

    expect(reason?.message).toMatch(/more than your facts/);
    expect(reason?.message).toMatch(/company/);
  });

  it("names every open reason, each with words for the page", () => {
    const open = canHandOff({
      ...CLEAR,
      flags: [FLAG],
      verdicts: [
        verdict("S2", { verdict: "overstated", note: "Five years is more than the facts show." }),
      ],
      unconfirmed: ["S5"],
      attachments: [{ name: "Portfolio", ticked: false }],
      contact: { kind: "email", needsRetype: true, retyped: null },
      addressChecks: [
        BLOCKING_CHECK,
        { kind: "free_mail", blocking: false, message: "A personal address." },
      ],
      duplicates: [{ reason: "the same company and role", applyAgain: false }],
      scam: { signals: ["asks for a fee"], overridden: false },
      sent: true,
    });

    expect(open.map((reason) => reason.kind)).toEqual([
      "sent",
      "scam",
      "duplicate",
      "contact",
      "address_check",
      "flag",
      "judge",
      "unconfirmed_edit",
      "attachment",
    ]);
    for (const reason of open) expect(reason.message.length).toBeGreaterThan(0);
  });
});
