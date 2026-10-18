import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact } from "@/core/profile/schema";

import { buildMessageKit, NEEDS_YOUR_LINE, type ProfileParts } from "./build";
import {
  type DraftAnswer,
  type FitRow,
  type KitBlock,
  MESSAGE_LIMIT,
  type MessageKit,
  messageLength,
  messageText,
} from "./kit";
import { type KitContext, validateKit } from "./validate";

/* Message kits: drafting AC6's merged gap line, AC8's sign-off, and over_limit at 600 characters. */

const record = (): JobRecord =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json"),
      "utf8",
    ),
  ) as JobRecord;

type Requirement = Role["requirements"][number];
const requirement = (id: string, skills: string[], text = skills.join(" ")): Requirement => ({
  id,
  text,
  priority: "must",
  kind: "skill",
  skills,
  depth: "production",
  years: -1,
});

// The post's role, with two must-haves the profile does not meet.
const role = (): Role => {
  const source = record().roles[0]!;
  return {
    ...source,
    requirements: [
      ...source.requirements,
      requirement("R5", ["kubernetes"]),
      requirement("R6", ["terraform"]),
    ],
  };
};

const fact = (overrides: Partial<Fact> & Pick<Fact, "id">): Fact => ({
  statement: "A statement.",
  phrase: "a phrase",
  kind: "experience",
  skills: [],
  depth: "production",
  source: "test",
  approved: true,
  ...overrides,
});

const profile: ProfileParts = {
  facts: [
    fact({ id: "F-react", skills: ["react", "nextjs"], years: 5 }),
    fact({ id: "F-node", skills: ["nodejs", "postgresql"], years: 4 }),
    fact({ id: "F-docker", skills: ["docker"], phrase: "Docker deployments on managed platforms" }),
    fact({ id: "F-scripts", skills: ["linux"], phrase: "shell scripts for my own servers" }),
  ],
  knownGaps: [
    { id: "K-aws", skills: ["aws"], line: "I have not used AWS at work.", approved: true },
  ],
  gapTemplates: [
    {
      id: "G-not-professional",
      text: "I haven't used {skill} professionally; the closest is {related}.",
    },
    { id: "G-learning", text: "I am learning {skill} now." },
  ],
};

const SIGN_OFF = ["Sam Rivera", "Portfolio: https://sam.example.com"].join(String.fromCharCode(10));

type AnswerBlock = DraftAnswer["blocks"][number];
const NO_GAP = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };
const sentence = (text: string, overrides: Partial<AnswerBlock> = {}): AnswerBlock => ({
  id: "S0",
  text,
  paragraph_break: false,
  class: "claim",
  fact_ids: ["F-react"],
  fields: [],
  gap: NO_GAP,
  ...overrides,
});
const gap = (requirementId: string, choice: Partial<typeof NO_GAP>): AnswerBlock => ({
  id: "S0",
  text: "",
  paragraph_break: false,
  class: "gap",
  fact_ids: [],
  fields: [],
  gap: { ...NO_GAP, requirement_id: requirementId, ...choice },
});

const build = (blocks: AnswerBlock[], forRole: Role = role()) =>
  buildMessageKit({ fit: [], blocks }, { role: forRole, signOff: SIGN_OFF, profile }).kit;

describe("buildMessageKit", () => {
  it("keeps the model's sentences and ends with the profile's sign-off, with no subject, greeting or closing", () => {
    const kit = build([
      sentence("Hello, I would like to apply for the role.", { class: "courtesy", fact_ids: [] }),
      sentence("I have built production React applications for five years."),
    ]);

    expect(kit).toEqual({
      kind: "message",
      blocks: [
        expect.objectContaining({ id: "S1", text: "Hello, I would like to apply for the role." }),
        expect.objectContaining({
          id: "S2",
          text: "I have built production React applications for five years.",
        }),
      ],
      signOff: SIGN_OFF,
    });
    expect(
      messageText(kit).endsWith(`five years.${String.fromCharCode(10).repeat(2)}${SIGN_OFF}`),
    ).toBe(true);
  });

  it("merges the gap lines one template and one related fact build into one line, answering each must-have", () => {
    const kit = build([
      sentence("I have built production React applications for five years."),
      gap("R5", { template_id: "G-not-professional", related_fact_id: "F-docker" }),
      gap("R6", { template_id: "G-not-professional", related_fact_id: "F-docker" }),
      sentence("Thank you.", { class: "courtesy", fact_ids: [] }),
    ]);

    expect(kit.blocks.map((block) => block.text)).toEqual([
      "I have built production React applications for five years.",
      "I haven't used Kubernetes or Terraform professionally; the closest is Docker deployments on managed platforms.",
      "Thank you.",
    ]);
    expect(kit.blocks.map((block) => block.id)).toEqual(["S1", "S2", "S3"]);
    expect(kit.blocks[1]).toMatchObject({
      class: "gap",
      gap: {
        requirementId: "R5",
        knownLineId: "",
        templateId: "G-not-professional",
        relatedFactId: "F-docker",
      },
      alsoAnswers: ["R6"],
    });
  });

  it("lists the skills with and where the template's words before the skill hold no negation", () => {
    const kit = build([
      gap("R5", { template_id: "G-learning" }),
      gap("R6", { template_id: "G-learning" }),
    ]);

    expect(kit.blocks.map((block) => block.text)).toEqual([
      "I am learning Kubernetes and Terraform now.",
    ]);
  });

  it("names a skill once when two must-haves lack the same one", () => {
    const twice: Role = {
      ...role(),
      requirements: [
        ...role().requirements,
        requirement("R7", ["k8s"], "Kubernetes in production"),
      ],
    };

    const kit = build(
      [
        gap("R5", { template_id: "G-not-professional", related_fact_id: "F-docker" }),
        gap("R7", { template_id: "G-not-professional", related_fact_id: "F-docker" }),
      ],
      twice,
    );

    expect(kit.blocks).toHaveLength(1);
    expect(kit.blocks[0]).toMatchObject({
      text: "I haven't used Kubernetes professionally; the closest is Docker deployments on managed platforms.",
      alsoAnswers: ["R7"],
    });
  });

  it("keeps a known line, a line from another template or related fact, and the owner's line as they are", () => {
    const withAws: Role = {
      ...role(),
      requirements: role().requirements.map((each) =>
        each.id === "R4" ? { ...each, priority: "must" as const } : each,
      ),
    };

    const kit = build(
      [
        gap("R4", { known_line_id: "K-aws" }),
        gap("R5", { template_id: "G-not-professional", related_fact_id: "F-docker" }),
        gap("R6", { template_id: "G-not-professional", related_fact_id: "F-scripts" }),
        gap("R2", { template_id: "G-learning" }),
      ],
      withAws,
    );

    expect(kit.blocks.map((block) => block.text)).toEqual([
      "I have not used AWS at work.",
      "I haven't used Kubernetes professionally; the closest is Docker deployments on managed platforms.",
      "I haven't used Terraform professionally; the closest is shell scripts for my own servers.",
      NEEDS_YOUR_LINE,
    ]);
    expect(kit.blocks.every((block) => block.alsoAnswers === undefined)).toBe(true);
  });

  it("keeps a paragraph's end where a merged line leaves its place", () => {
    const kit = build([
      gap("R5", { template_id: "G-learning" }),
      sentence("I have built production React applications for five years."),
      { ...gap("R6", { template_id: "G-learning" }), paragraph_break: true },
      sentence("Thank you.", { class: "courtesy", fact_ids: [] }),
    ]);

    expect(kit.blocks.map((block) => [block.text, block.paragraphBreak])).toEqual([
      ["I am learning Kubernetes and Terraform now.", false],
      ["I have built production React applications for five years.", true],
      ["Thank you.", false],
    ]);
  });
});

describe("messageText", () => {
  it("is the paragraphs and then the sign-off, each after a blank line, counted in characters", () => {
    const line = String.fromCharCode(10);
    const kit: MessageKit = {
      kind: "message",
      blocks: [
        block({ id: "S1", class: "courtesy", text: "Hello.", paragraphBreak: true }),
        block({ id: "S2", class: "claim", text: "I build React apps.", factIds: ["F-react"] }),
        block({ id: "S3", class: "claim", text: "Thanks!", factIds: ["F-react"] }),
      ],
      signOff: "Sam",
    };

    expect(messageText(kit)).toBe(
      `Hello.${line}${line}I build React apps. Thanks!${line}${line}Sam`,
    );
    // An emoji is one character, however many units it takes in JavaScript.
    const waving = String.fromCodePoint(0x1f44b);
    expect(messageLength({ ...kit, signOff: waving })).toBe(messageText(kit).length - 3 + 1);
  });
});

function block(overrides: Partial<KitBlock> & Pick<KitBlock, "id" | "text" | "class">): KitBlock {
  return { paragraphBreak: false, factIds: [], fields: [], gap: null, ...overrides };
}

describe("validateKit on a message kit", () => {
  const fit = (): FitRow[] => [
    { requirementId: "R1", verdict: "met", factIds: ["F-react"], note: "" },
    { requirementId: "R2", verdict: "met", factIds: ["F-node"], note: "" },
    { requirementId: "R3", verdict: "met", factIds: ["F-node"], note: "" },
    { requirementId: "R4", verdict: "gap", factIds: [], note: "" },
    { requirementId: "R5", verdict: "gap", factIds: [], note: "" },
    { requirementId: "R6", verdict: "gap", factIds: [], note: "" },
  ];
  const context = (overrides: Partial<KitContext> = {}): KitContext => ({
    record: record(),
    role: role(),
    profile,
    fit: fit(),
    wordLimit: 180,
    keyword: null,
    subjectFormat: null,
    markers: ["0f1e2d3c4b5a69788796a5b4c3d2e1f0"],
    ...overrides,
  });
  const merged = (): KitBlock =>
    block({
      id: "S2",
      class: "gap",
      text: "I am learning Kubernetes and Terraform now.",
      gap: { requirementId: "R5", knownLineId: "", templateId: "G-learning", relatedFactId: "" },
      alsoAnswers: ["R6"],
    });
  const kit = (blocks: KitBlock[] = [], signOff = SIGN_OFF): MessageKit => ({
    kind: "message",
    blocks: [
      block({
        id: "S1",
        class: "claim",
        text: "I have built production React applications for five years.",
        factIds: ["F-react"],
      }),
      merged(),
      ...blocks,
    ],
    signOff,
  });
  const kinds = (subject: MessageKit, ctx = context()) =>
    validateKit(subject, ctx).map(({ kind, at }) => [kind, at]);

  it("raises nothing on a clean message, the merged line answering both must-haves", () => {
    expect(kinds(kit())).toEqual([]);
  });

  it("asks for a gap line for a must-have the merged line no longer answers", () => {
    const shorter = kit();
    shorter.blocks[1] = { ...merged(), alsoAnswers: [] };

    expect(kinds(shorter)).toEqual([["missing_gap_line", "R6"]]);
  });

  it("flags a merged line answering a requirement the post does not have", () => {
    const wrong = kit();
    wrong.blocks[1] = { ...merged(), alsoAnswers: ["R6", "R9"] };

    expect(kinds(wrong)).toEqual([["invalid_citation", "S2"]]);
  });

  it("flags a message over 600 characters with the sign-off, and not one at 600", () => {
    const at = (length: number) => {
      const base = kit([], "");
      const filler = "x".repeat(length - messageLength(base) - 2);
      return { ...base, signOff: filler };
    };

    expect(messageLength(at(MESSAGE_LIMIT))).toBe(600);
    expect(kinds(at(MESSAGE_LIMIT))).toEqual([]);
    expect(validateKit(at(MESSAGE_LIMIT + 1), context())).toEqual([
      {
        kind: "over_limit",
        at: "body",
        message: "The message is 601 characters with your sign-off; the limit is 600.",
      },
    ]);
  });

  it("weighs no word limit and no subject, and names the message in its flags", () => {
    const flags = validateKit(kit(), context({ wordLimit: 5, keyword: "pineapple" }));

    expect(flags).toEqual([
      {
        kind: "keyword_missing",
        at: "body",
        message: "The post asks you to include a keyword, and the message does not.",
      },
    ]);
  });

  it("finds an internal ID in the sign-off too", () => {
    expect(kinds(kit([], `${SIGN_OFF} F-react`))).toEqual([["reference_leak", "kit"]]);
  });
});
