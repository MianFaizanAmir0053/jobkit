import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JobRecord } from "@/core/extraction/record";
import type { LlmInput } from "@/core/ports";
import type { Fact } from "@/core/profile/schema";

import {
  citedFacts,
  FORM_JUDGE_RULES,
  isBlocking,
  JUDGE_RULES,
  judgeContent,
  type JudgeAnswer,
  mergeVerdicts,
  NO_VERDICT,
} from "./judge";
import type { EmailKit, KitBlock } from "./kit";

/* The judge: drafting AC9. */

const record = JSON.parse(
  readFileSync(
    join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json"),
    "utf8",
  ),
) as JobRecord;
const role = record.roles[0]!;

const fact = (id: string, statement: string): Fact => ({
  id,
  statement,
  phrase: "a phrase",
  kind: "experience",
  skills: ["react"],
  depth: "production",
  years: 5,
  source: "sample CV",
  approved: true,
});

const block = (
  overrides: Partial<KitBlock> & Pick<KitBlock, "id" | "text" | "class">,
): KitBlock => ({
  paragraphBreak: false,
  factIds: [],
  fields: [],
  gap: null,
  ...overrides,
});

const kit: EmailKit = {
  kind: "email",
  subject: "Application - Senior Full-Stack Engineer - Sam Rivera",
  greeting: "Dear Hiring Team,",
  blocks: [
    block({
      id: "S1",
      class: "post",
      text: "I am applying for the Senior Full-Stack Engineer role at Northwind Analytics.",
      fields: ["title", "company.name"],
    }),
    block({
      id: "S2",
      class: "claim",
      text: "I led React teams for ten years.",
      factIds: ["F-react"],
    }),
    block({ id: "S3", class: "courtesy", text: "Yes." }),
    block({ id: "S4", class: "courtesy", text: "Your company is the best in the region." }),
    block({
      id: "S5",
      class: "gap",
      text: "I haven't used AWS professionally; the closest is Docker.",
      gap: { requirementId: "R4", knownLineId: "", templateId: "G-x", relatedFactId: "F-docker" },
    }),
  ],
  closing: "Kind regards,",
};

const verdict = (
  id: string,
  value: JudgeAnswer["verdicts"][number]["verdict"],
  companyClaim = false,
) => ({
  block_id: id,
  verdict: value,
  company_claim: companyClaim,
  note: value === "overstated" ? "Five years, not ten; no leadership shown." : "",
});

describe("mergeVerdicts", () => {
  it("keeps each verdict, counts a missing one as unsupported, and judges the drafter's claims as claims", () => {
    const answer: JudgeAnswer = {
      verdicts: [
        verdict("S1", "not_a_claim"),
        verdict("S2", "overstated"),
        // The drafter called S2 a claim: a "not a claim" here could not stand. S3 is a courtesy.
        verdict("S3", "not_a_claim"),
        verdict("S4", "not_a_claim", true),
      ],
    };

    const merged = mergeVerdicts(kit, answer);

    expect(
      merged.map(({ blockId, verdict: value, companyClaim }) => [blockId, value, companyClaim]),
    ).toEqual([
      ["S1", "not_a_claim", false],
      ["S2", "overstated", false],
      ["S3", "not_a_claim", false],
      ["S4", "not_a_claim", true],
      ["S5", "unsupported", false],
    ]);
    expect(merged[4]!.note).toBe(NO_VERDICT);
    expect(merged.filter(isBlocking).map((entry) => entry.blockId)).toEqual(["S2", "S4", "S5"]);
  });

  it("does not let the judge wave a drafter's claim through as no claim", () => {
    const merged = mergeVerdicts(kit, { verdicts: [verdict("S2", "not_a_claim")] });

    expect(merged.find((entry) => entry.blockId === "S2")?.verdict).toBe("unsupported");
  });
});

describe("the judge's rules", () => {
  it("tell the check it weighs a form's cover note and answers, an email's as they always read", () => {
    expect(JUDGE_RULES.startsWith("You check an application email that someone else drafted")).toBe(
      true,
    );
    expect(
      FORM_JUDGE_RULES.startsWith(
        "You check an application through a job's form, its cover note and its answers, that someone else drafted",
      ),
    ).toBe(true);
  });
});

describe("judgeContent", () => {
  const facts = [
    fact("F-react", "I have built React apps for five years."),
    fact("F-docker", "I deploy with Docker."),
  ];
  const texts = (content: readonly LlmInput[]) =>
    content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

  it("sends the cited facts in full, and the blocks and post fields only between the markers, with no classes", () => {
    const content = texts(judgeContent(kit, citedFacts(kit, facts), { record, role }, "abc123"));
    const inside = content.slice(
      content.indexOf("BEGIN KIT DATA abc123"),
      content.indexOf("END KIT DATA abc123"),
    );
    const outside = content.replace(inside, "");

    expect(outside).toContain("I have built React apps for five years.");
    expect(outside).toContain("I deploy with Docker.");
    expect(outside).toContain("sample CV");
    for (const text of [
      "I led React teams for ten years.",
      "Northwind Analytics",
      "Senior Full-Stack Engineer",
      "AWS",
    ]) {
      expect(inside).toContain(text);
      expect(outside).not.toContain(text);
    }
    expect(content).not.toMatch(/"class"|courtesy|"claim"/);
  });

  it("cites only the facts the kit uses: claims' facts and gap lines' related facts", () => {
    const unused = fact("F-unused", "Something the email never says.");

    expect(citedFacts(kit, [...facts, unused]).map((entry) => entry.id)).toEqual([
      "F-react",
      "F-docker",
    ]);
  });
});
