import { describe, expect, it } from "vitest";

import { ADDRESS_CHECKS_VERSION, type AddressCheck } from "./addressChecks";
import { canHandOff } from "./canHandOff";
import {
  approvals,
  approvalsKey,
  approveAll,
  approvable,
  decide,
  decisionsSchema,
  flagKey,
  gateInputOf,
  keptLookup,
  type KitParts,
  needsNewWords,
  NO_DECISIONS,
  reviewActionSchema,
  type ReviewDecisions,
  withFlagNames,
} from "./decisions";

/* The owner's decisions on a kit, which the outbound gate reads: review AC1 and AC4. */

const FLAG = {
  kind: "fit_unverified" as const,
  at: "R2",
  message: "Only you can confirm you meet this requirement.",
};
/** FLAG's name, as the page and the decisions give it. */
const F = flagKey(FLAG);

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
  skipped: false,
  mustHaves: ["R2"],
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
      { kind: "check_flag", flag: F },
      { kind: "attach", id: "A2", ticked: true },
      { kind: "continue_anyway" },
    ] as const) {
      decisions = decide(decisions, action);
    }
    decisions = decide(decisions, { kind: "retype", value: " jobs@example.com " }, []);

    expect(decisions).toEqual({
      checked: ["S2"],
      flagsChecked: [F],
      retyped: { value: "jobs@example.com", checks: [] },
      attached: ["A2"],
      continueAnyway: true,
      lookups: [{ address: "jobs@example.com", version: ADDRESS_CHECKS_VERSION, checks: [] }],
      meets: [],
      edits: {},
      confirmed: [],
      added: [],
      deleted: [],
    });
    expect(decide(decisions, { kind: "uncheck", blockId: "S2" }).checked).toEqual([]);
    expect(decide(decisions, { kind: "uncheck_flag", flag: F }).flagsChecked).toEqual([]);
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

  it('records that the owner meets a requirement, by its ID, apart from "I checked this"', () => {
    const meets = decide(NO_DECISIONS, { kind: "meets", requirementId: "R2", ticked: true });

    expect(meets).toEqual({ ...NO_DECISIONS, meets: ["R2"] });
    expect(decide(meets, { kind: "meets", requirementId: "R2", ticked: true })).toEqual(meets);
    expect(decide(meets, { kind: "meets", requirementId: "R2", ticked: false }).meets).toEqual([]);
    expect(
      reviewActionSchema.safeParse({ kind: "meets", requirementId: "F1", ticked: true }).success,
    ).toBe(false);
  });

  it("keeps the owner's words for a sentence, which they confirm, and takes them back", () => {
    let decisions = decide(NO_DECISIONS, {
      kind: "edit",
      blockId: "S2",
      text: "  I built React apps for four years.  ",
    });
    expect(decisions.edits).toEqual({ S2: "I built React apps for four years." });
    decisions = decide(decisions, { kind: "confirm", blockId: "S2" });
    expect(decisions.confirmed).toEqual(["S2"]);
    // Changed again: it needs confirming again.
    decisions = decide(decisions, { kind: "edit", blockId: "S2", text: "Four years of React." });
    expect(decisions.confirmed).toEqual([]);
    expect(decide(decisions, { kind: "revert", blockId: "S2" })).toMatchObject({
      edits: {},
      confirmed: [],
    });
    expect(
      reviewActionSchema.safeParse({ kind: "edit", blockId: "S1", text: "x".repeat(1501) }).success,
    ).toBe(false);
    expect(reviewActionSchema.safeParse({ kind: "edit", blockId: "S1", text: "   " }).success).toBe(
      false,
    );
  });

  it("adds the owner's sentence after another or first, each to be confirmed, and edits it in place", () => {
    let decisions = decide(NO_DECISIONS, {
      kind: "add",
      after: "S2",
      text: "  I led a team of four.  ",
    });
    decisions = decide(decisions, { kind: "add", after: "", text: "First words." });
    expect(decisions.added).toEqual([
      { id: "N1", after: "S2", text: "I led a team of four." },
      { id: "N2", after: "", text: "First words." },
    ]);
    decisions = decide(decisions, { kind: "confirm", blockId: "N1" });
    decisions = decide(decisions, { kind: "edit", blockId: "N1", text: "I led a team of five." });

    expect(decisions.added[0]).toEqual({ id: "N1", after: "S2", text: "I led a team of five." });
    // Changed: confirmed anew; and a sentence the owner added is no edit of a drafted one.
    expect(decisions.confirmed).toEqual([]);
    expect(decisions.edits).toEqual({});
  });

  it("deletes a drafted sentence with its edit and checks, until the owner takes the deletion back", () => {
    const onS2 = flagKey({ kind: "sensitive_topic_drafted", at: "S2", message: "Check this." });
    let decisions = decide(NO_DECISIONS, { kind: "edit", blockId: "S2", text: "New words." });
    decisions = decide(decisions, { kind: "confirm", blockId: "S2" });
    decisions = decide(decisions, { kind: "check_flag", flag: onS2 });
    decisions = decide(decisions, { kind: "delete", blockId: "S2" });

    expect(decisions).toMatchObject({
      deleted: ["S2"],
      edits: {},
      confirmed: [],
      flagsChecked: [],
    });
    expect(decide(decisions, { kind: "revert", blockId: "S2" }).deleted).toEqual([]);
  });

  it("deletes an added sentence outright, one added after it taking its place", () => {
    let decisions = decide(NO_DECISIONS, { kind: "add", after: "S1", text: "One." });
    decisions = decide(decisions, { kind: "add", after: "N1", text: "Two." });
    decisions = decide(decisions, { kind: "confirm", blockId: "N1" });
    decisions = decide(decisions, { kind: "delete", blockId: "N1" });

    expect(decisions).toMatchObject({
      added: [{ id: "N2", after: "S1", text: "Two." }],
      deleted: [],
      confirmed: [],
    });
    // The next sentence added is named after the highest.
    const next = decide(decisions, { kind: "add", after: "S1", text: "Three." });
    expect(next.added.map((each) => each.id)).toEqual(["N2", "N3"]);
  });

  it("holds the gate on each added sentence until confirmed, and on no deleted one", () => {
    const parts: KitParts = { ...PARTS, blocks: ["S1", "S2", "S3", "N1"] };
    let decisions = decide(NO_DECISIONS, { kind: "add", after: "S3", text: "Mine." });
    expect(gateInputOf(parts, decisions).unconfirmed).toEqual(["N1"]);
    decisions = decide(decisions, { kind: "confirm", blockId: "N1" });
    expect(gateInputOf(parts, decisions).unconfirmed).toEqual([]);

    // S2 is overstated: deleted, its verdict holds nothing, and Approve & send marks nothing for it.
    const deleted = decide(NO_DECISIONS, { kind: "delete", blockId: "S2" });
    expect(gateInputOf(PARTS, deleted).verdicts.map((each) => each.blockId)).not.toContain("S2");
    expect(approvable(PARTS, deleted)).not.toContain("sentence:S2");
    expect(approveAll(PARTS, deleted).checked).toEqual([]);
    // Nor does an edit of it, deleted after, wait for confirming.
    const edited = decide(decide(NO_DECISIONS, { kind: "edit", blockId: "S2", text: "x" }), {
      kind: "delete",
      blockId: "S2",
    });
    expect(gateInputOf(PARTS, edited).unconfirmed).toEqual([]);
  });

  it("takes an added sentence's words as an edit's, after a sentence or first, and a deletion by ID", () => {
    const parses = (action: object) => reviewActionSchema.safeParse(action).success;

    expect(parses({ kind: "add", after: "S2", text: "Mine." })).toBe(true);
    expect(parses({ kind: "add", after: "", text: "Mine." })).toBe(true);
    expect(parses({ kind: "add", after: "S2", text: "  " })).toBe(false);
    expect(parses({ kind: "add", after: "S2", text: "x".repeat(1501) })).toBe(false);
    expect(parses({ kind: "delete", blockId: "N1" })).toBe(true);
  });

  it("reads decisions kept before sentences were added or deleted as adding and deleting none", () => {
    const { added, deleted, ...before } = NO_DECISIONS;

    expect([added, deleted]).toEqual([[], []]);
    expect(decisionsSchema.parse(before)).toMatchObject({ added: [], deleted: [] });
  });

  it("names a flag by what it found, so it keeps its name when validate runs again", () => {
    const over = { kind: "over_limit" as const, at: "body", message: "Too long." };

    expect(flagKey({ ...over })).toBe(flagKey(over));
    expect(flagKey(over)).toMatch(/^over_limit@body~[0-9a-f]{8}$/);
    // Two at one place, as two lines aimed at AI, differ by what they found.
    const banana = {
      kind: "ai_instruction_followed" as const,
      at: "kit",
      message: "The email repeats banana.",
    };
    expect(flagKey(banana)).not.toBe(flagKey({ ...banana, message: "The email repeats kiwi." }));
    expect(reviewActionSchema.safeParse({ kind: "check_flag", flag: flagKey(over) }).success).toBe(
      true,
    );
    // A place among the kit's flags, as a page drawn before flags were named posts it, is read,
    // to be refused as no flag the kit has (recordReview); anything else is not a name.
    expect(reviewActionSchema.safeParse({ kind: "check_flag", flag: "F12" }).success).toBe(true);
    for (const flag of ["F12x", "over_limit@body", "over_limit@body~1A2B3C4D"]) {
      expect(reviewActionSchema.safeParse({ kind: "check_flag", flag }).success).toBe(false);
    }
  });

  it('takes back "I checked this" on a sentence\'s flags when the owner edits it, or takes the edit back', () => {
    const named = (kind: "sensitive_topic_drafted" | "keyword_missing", at: string) =>
      flagKey({ kind, at, message: "Check this." });
    const onS3 = named("sensitive_topic_drafted", "S3");
    const onS30 = named("sensitive_topic_drafted", "S30");
    const onBody = named("keyword_missing", "body");
    const checked = [onS3, onS30, onBody, F].reduce(
      (decisions, flag) => decide(decisions, { kind: "check_flag", flag }),
      NO_DECISIONS,
    );

    const edited = decide(checked, { kind: "edit", blockId: "S3", text: "New words." });
    expect(edited.flagsChecked).toEqual([onS30, onBody, F]);
    // Checked again on the owner's words, then the edit taken back: the drafted words are back.
    const again = decide(edited, { kind: "check_flag", flag: onS3 });
    expect(decide(again, { kind: "revert", blockId: "S3" }).flagsChecked).toEqual([
      onS30,
      onBody,
      F,
    ]);
    // The separate check's verdict on S3 weighed the drafted words, which a revert brings back.
    const judged = decide(checked, { kind: "check", blockId: "S3" });
    expect(decide(judged, { kind: "edit", blockId: "S3", text: "New words." }).checked).toEqual([
      "S3",
    ]);
  });

  it("names a decision kept by a flag's place among drafting's as what that flag found", () => {
    const over = { kind: "over_limit" as const, at: "body", message: "Too long." };
    const kept = { ...NO_DECISIONS, flagsChecked: ["F2", "F9", F] };

    expect(withFlagNames(kept, [FLAG, over]).flagsChecked).toEqual([flagKey(over), F]);
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
      { kind: "check_flag", flag: F },
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
      flagsChecked: ["over_limit@body~00000000"],
      retyped: null,
      attached: ["A9"],
      continueAnyway: false,
      lookups: [],
      meets: ["R9"],
      edits: { S9: "A sentence the kit no longer has." },
      confirmed: ["S9"],
      added: [],
      deleted: ["S9"],
    };

    const input = gateInputOf({ ...PARTS, blocks: ["S1"] }, decisions);

    expect(input.checked).toEqual([]);
    expect(input.flags).toEqual([FLAG]);
    expect(input.attachments).toEqual([{ name: "Portfolio link", ticked: false }]);
    // A verdict on a sentence no longer in the kit holds nothing.
    expect(input.verdicts.map((verdict) => verdict.blockId)).toEqual(["S1"]);
  });
});

describe("an edited sentence", () => {
  it("holds the kit until the owner confirms it, in place of the separate check's verdict", () => {
    const kinds = (decisions: ReviewDecisions) =>
      canHandOff(gateInputOf(PARTS, decisions)).map((reason) => reason.kind);
    expect(kinds(NO_DECISIONS)).toContain("judge");

    const edited = decide(NO_DECISIONS, {
      kind: "edit",
      blockId: "S2",
      text: "Four years of React.",
    });

    // S2's verdict was on the words the owner replaced: their edit holds it now, until confirmed.
    expect(kinds(edited)).not.toContain("judge");
    expect(kinds(edited)).toContain("unconfirmed_edit");
    expect(kinds(decide(edited, { kind: "confirm", blockId: "S2" }))).not.toContain(
      "unconfirmed_edit",
    );
    // Approve & send confirms no edit for the owner, nor checks the verdict it replaced.
    expect(approvable(PARTS, edited)).not.toContain("sentence:S2");
    expect(approveAll(PARTS, edited).checked).toEqual([]);
  });
});

describe("approveAll", () => {
  it('clears a requirement only the owner can confirm once they say they meet it, as "I checked this" does', () => {
    const reasons = (decisions: ReviewDecisions) =>
      canHandOff(gateInputOf(PARTS, decisions)).filter((reason) => reason.kind === "flag");

    expect(reasons(NO_DECISIONS)).toHaveLength(1);
    expect(
      reasons(decide(NO_DECISIONS, { kind: "meets", requirementId: "R2", ticked: true })),
    ).toEqual([]);
    expect(reasons(decide(NO_DECISIONS, { kind: "check_flag", flag: F }))).toEqual([]);
    // Another requirement's word clears nothing here.
    expect(
      reasons(decide(NO_DECISIONS, { kind: "meets", requirementId: "R9", ticked: true })),
    ).toHaveLength(1);
  });

  it('marks "I checked this" on every flagged sentence and flag, and no other decision', () => {
    const over = {
      kind: "over_limit" as const,
      at: "body",
      message: "The email runs past the limit.",
    };
    const parts: KitParts = { ...PARTS, flags: [over] };
    const approved = approveAll(parts, decide(NO_DECISIONS, { kind: "check", blockId: "S2" }));

    expect(approved).toEqual({ ...NO_DECISIONS, checked: ["S2"], flagsChecked: [flagKey(over)] });
    // The hard stops still hold the kit: the scam warning, the possible repeat, the contact, the
    // attachment.
    expect(canHandOff(gateInputOf(parts, approved)).map((reason) => reason.kind)).toEqual([
      "scam",
      "duplicate",
      "contact",
      "attachment",
    ]);
  });

  it("leaves to the owner a requirement only they can confirm, said or not", () => {
    // FLAG is one: Approve & send neither says they meet it nor checks it for them.
    expect(approveAll(PARTS, NO_DECISIONS).flagsChecked).toEqual([]);
    const said = decide(NO_DECISIONS, { kind: "meets", requirementId: "R2", ticked: true });
    expect(approveAll(PARTS, said)).toMatchObject({ flagsChecked: [], meets: ["R2"] });
  });

  it("asks for new words when the owner checked a must-have only they can confirm without saying they meet it", () => {
    const checked = decide(NO_DECISIONS, { kind: "check_flag", flag: F });

    expect(needsNewWords(PARTS, NO_DECISIONS)).toBe(false);
    expect(needsNewWords(PARTS, checked)).toBe(true);
    // A nice-to-have the email may never mention needs no new words.
    expect(needsNewWords({ ...PARTS, mustHaves: [] }, checked)).toBe(false);
    expect(
      needsNewWords(PARTS, decide(checked, { kind: "meets", requirementId: "R2", ticked: true })),
    ).toBe(false);
  });

  it("names what Approve & send marks: the sentences and flags the gate holds that it may settle", () => {
    const parts: KitParts = {
      ...PARTS,
      flags: [
        FLAG,
        { kind: "over_limit", at: "body", message: "Too long." },
        { kind: "needs_your_line", at: "S3", message: "Needs your line." },
        { kind: "keyword_missing", at: "body", message: "No keyword." },
      ],
    };

    const [, over, , keyword] = parts.flags.map(flagKey);
    // S2 is overstated; FLAG is the owner's to answer and needs_your_line new words.
    expect(approvable(parts, NO_DECISIONS)).toEqual([
      "sentence:S2",
      `flag:${over}`,
      `flag:${keyword}`,
    ]);
    const some = decide(decide(NO_DECISIONS, { kind: "check", blockId: "S2" }), {
      kind: "check_flag",
      flag: keyword!,
    });
    expect(approvable(parts, some)).toEqual([`flag:${over}`]);
  });

  it("gives the confirmation each sentence and flag it marks, not a name to read them back from", () => {
    const parts: KitParts = {
      ...PARTS,
      flags: [
        FLAG,
        { kind: "over_limit", at: "body", message: "Too long." },
        { kind: "keyword_missing", at: "body", message: "No keyword." },
      ],
    };

    const [, over, keyword] = parts.flags;
    expect(approvals(parts, NO_DECISIONS)).toEqual([
      { key: "sentence:S2", blockId: "S2" },
      { key: `flag:${flagKey(over!)}`, flag: over },
      { key: `flag:${flagKey(keyword!)}`, flag: keyword },
    ]);
    // Two flags of one name are both listed, and the press names them once.
    const twice: KitParts = { ...parts, flags: [over!, { ...over! }] };
    expect(approvals(twice, NO_DECISIONS).filter((each) => "flag" in each)).toHaveLength(2);
    expect(approvable(twice, NO_DECISIONS)).toEqual(["sentence:S2", `flag:${flagKey(over!)}`]);
  });

  it("keys what Approve & send marks, as short with sixty marks as with one, and in any order", () => {
    const parts: KitParts = {
      ...PARTS,
      flags: [FLAG, { kind: "over_limit", at: "body", message: "Too long." }],
    };
    const key = approvalsKey(parts, NO_DECISIONS);

    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(approvalsKey({ ...parts, flags: [...parts.flags].reverse() }, NO_DECISIONS)).toBe(key);
    // A decision made after the page was drawn, then taken back.
    const checked = decide(NO_DECISIONS, { kind: "check", blockId: "S2" });
    expect(approvalsKey(parts, checked)).not.toBe(key);
    expect(approvalsKey(parts, decide(checked, { kind: "uncheck", blockId: "S2" }))).toBe(key);
    const many: KitParts = {
      ...parts,
      flags: Array.from({ length: 60 }, (_, i) => ({
        kind: "sensitive_topic_drafted" as const,
        at: `S${i + 10}`,
        message: "Check this.",
      })),
    };
    expect(approvalsKey(many, NO_DECISIONS)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("reads decisions kept before the fit tick as saying the owner meets nothing", () => {
    const { meets, ...before } = NO_DECISIONS;

    expect(meets).toEqual([]);
    expect(decisionsSchema.parse(before).meets).toEqual([]);
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

  it("leaves the flags only new words resolve, since it sends the words as they stand", () => {
    const words = (kind: KitParts["flags"][number]["kind"]) => ({ kind, at: "S1", message: "" });
    const parts: KitParts = {
      ...PARTS,
      flags: [
        words("needs_your_line"),
        FLAG,
        words("subject_placeholder"),
        words("reference_leak"),
        words("ai_instruction_followed"),
        words("keyword_missing"),
      ],
    };

    // FLAG, the second, is a requirement only the owner can confirm: left to them too.
    expect(approveAll(parts, NO_DECISIONS).flagsChecked).toEqual([
      flagKey(words("keyword_missing")),
    ]);
    expect(needsNewWords(parts, NO_DECISIONS)).toBe(true);
    expect(needsNewWords({ flags: [FLAG, words("keyword_missing")] })).toBe(false);
  });
});
