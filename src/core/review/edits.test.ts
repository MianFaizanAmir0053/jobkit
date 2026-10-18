import { describe, expect, it } from "vitest";

import type { EmailKit, KitBlock } from "@/core/drafting/kit";

import { NO_DECISIONS } from "./decisions";
import { editedKit, listedSentences } from "./edits";

/* The email as it stands, with the owner's edits: drafting spec, "Owner edits"; review AC4. */

const block = (id: string, text: string, paragraphBreak = false): KitBlock => ({
  id,
  text,
  paragraphBreak,
  class: "claim",
  factIds: ["F-react"],
  fields: [],
  gap: null,
});

const KIT: EmailKit = {
  kind: "email",
  subject: "Application",
  greeting: "Dear Hiring Team,",
  blocks: [
    block("S1", "One."),
    block("S2", "Two.", true),
    block("S3", "Three."),
    block("S4", "Four.", true),
  ],
  closing: "Kind regards,",
};

/** Each sentence: its ID, its words, whether a paragraph ends with it, and whether the owner wrote it. */
const shape = (kit: EmailKit) =>
  kit.blocks.map((each) => [each.id, each.text, each.paragraphBreak, each.owner === true]);

describe("editedKit", () => {
  it("is the draft's email while the owner changed nothing", () => {
    expect(editedKit(KIT, NO_DECISIONS)).toEqual(KIT);
  });

  it("puts the owner's words in place, their sentences where they added them, and none they deleted", () => {
    const shown = editedKit(KIT, {
      edits: { S3: "Third." },
      added: [{ id: "N1", after: "S2", text: "Added." }],
      deleted: ["S1"],
    });

    expect(shape(shown)).toEqual([
      ["S2", "Two.", false, false],
      ["N1", "Added.", true, true],
      ["S3", "Third.", false, true],
      ["S4", "Four.", true, false],
    ]);
    // A sentence the owner added is theirs: it cites nothing.
    expect(shown.blocks[1]).toMatchObject({ class: "claim", factIds: [], fields: [], gap: null });
  });

  it("adds a sentence first, or after one the owner added, in the order they added them", () => {
    const shown = editedKit(KIT, {
      edits: {},
      added: [
        { id: "N1", after: "", text: "First." },
        { id: "N2", after: "S3", text: "After three." },
        { id: "N3", after: "N2", text: "After that." },
      ],
      deleted: [],
    });

    expect(shown.blocks.map((each) => each.id)).toEqual(["N1", "S1", "S2", "S3", "N2", "N3", "S4"]);
  });

  it("keeps a paragraph's end when the owner deletes the sentence that ended it", () => {
    const shown = editedKit(KIT, { edits: {}, added: [], deleted: ["S2"] });

    expect(shape(shown)).toEqual([
      ["S1", "One.", true, false],
      ["S3", "Three.", false, false],
      ["S4", "Four.", true, false],
    ]);
  });

  it("lists for the page each sentence the owner deleted in its place, apart from the email", () => {
    const decisions = {
      edits: {},
      added: [{ id: "N1", after: "S3", text: "Added." }],
      deleted: ["S2", "S3"],
    };

    expect(
      listedSentences(KIT, decisions).map(({ block, deleted }) => [block.id, deleted]),
    ).toEqual([
      ["S1", false],
      ["S2", true],
      ["S3", true],
      ["N1", false],
      ["S4", false],
    ]);
    expect(editedKit(KIT, decisions).blocks.map((each) => each.id)).toEqual(["S1", "N1", "S4"]);
  });

  it("makes a sentence the owner marked as answering a requirement its gap line", () => {
    const shown = editedKit(KIT, {
      edits: { S2: "I have not used Kubernetes." },
      added: [{ id: "N1", after: "S4", text: "Nor Terraform." }],
      deleted: [],
      answers: { S2: "R5", N1: "R6" },
    });

    expect(shown.blocks.find((each) => each.id === "S2")).toMatchObject({
      class: "gap",
      factIds: [],
      gap: { requirementId: "R5", knownLineId: "", templateId: "", relatedFactId: "" },
    });
    expect(shown.blocks.find((each) => each.id === "N1")).toMatchObject({
      class: "gap",
      gap: { requirementId: "R6" },
    });
  });

  it("keeps the place of a sentence added after one the owner then deleted", () => {
    const shown = editedKit(KIT, {
      edits: {},
      added: [{ id: "N1", after: "S3", text: "Added." }],
      deleted: ["S3"],
    });

    expect(shown.blocks.map((each) => each.id)).toEqual(["S1", "S2", "N1", "S4"]);
  });
});
