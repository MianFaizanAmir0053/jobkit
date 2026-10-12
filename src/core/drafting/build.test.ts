import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JobRecord, Role } from "@/core/extraction/record";
import type { Fact } from "@/core/profile/schema";

import {
  acceptedInstructions,
  BODY_WORD_LIMIT,
  buildEmailKit,
  CLOSING,
  DEFAULT_GREETING,
  gapLine,
  greetingFor,
  NEEDS_YOUR_LINE,
  oneLine,
  type ProfileParts,
  subjectFor,
} from "./build";
import type { DraftAnswer } from "./kit";

/* The parts of an email kit code writes: drafting AC6, AC7 and AC8. */

const record = (): JobRecord =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json"),
      "utf8",
    ),
  ) as JobRecord;

type Instruction = Role["instructions"][number];
const instruction = (overrides: Partial<Instruction>): Instruction => ({
  kind: "other",
  text: "",
  value: "",
  addressed_to_ai: false,
  ...overrides,
});

const fact = (overrides: Partial<Fact> & Pick<Fact, "id">): Fact => ({
  statement: "A statement.",
  phrase: "a phrase",
  kind: "skill",
  skills: [],
  depth: "production",
  source: "test",
  approved: true,
  ...overrides,
});

const profile: ProfileParts = {
  facts: [
    fact({ id: "F-docker", skills: ["docker"], phrase: "Docker deployments on managed platforms" }),
  ],
  knownGaps: [
    {
      id: "K-kubernetes",
      skills: ["kubernetes"],
      line: "I haven't run Kubernetes in production; I deploy containers with Docker.",
      approved: true,
    },
  ],
  gapTemplates: [
    {
      id: "G-not-professional",
      text: "I haven't used {skill} professionally; the closest is {related}.",
    },
    { id: "G-learning", text: "I am learning {skill} now." },
  ],
};

describe("acceptedInstructions", () => {
  it("takes the subject format, the tightest word limit and a plain keyword, never from a line aimed at AI", () => {
    const role: Role = {
      ...record().roles[0]!,
      instructions: [
        instruction({ kind: "subject_format", value: "AI wins", addressed_to_ai: true }),
        instruction({ kind: "subject_format", value: "Application for {role} - {name}" }),
        instruction({ kind: "word_limit", value: "Keep it under 150 words" }),
        instruction({ kind: "word_limit", value: "120", addressed_to_ai: true }),
        instruction({ kind: "include_keyword", value: "banana", addressed_to_ai: true }),
        instruction({ kind: "include_keyword", value: "  pineapple  " }),
      ],
    };

    expect(acceptedInstructions(role)).toEqual({
      subjectFormat: "Application for {role} - {name}",
      wordLimit: 150,
      keyword: "pineapple",
    });
  });

  it("takes only a limit in words, reading thousands with commas", () => {
    const limitOf = (value: string) =>
      acceptedInstructions({
        ...record().roles[0]!,
        instructions: [instruction({ kind: "word_limit", value })],
      }).wordLimit;

    expect(limitOf("Max 120 words")).toBe(120);
    expect(limitOf("1,000 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("one page")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("2-3 paragraphs")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("500 characters")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("100-150 words")).toBe(150);
  });

  it("reads a bare number as words only when the text does not make it a least or another unit", () => {
    const limitOf = (value: string, text = "") =>
      acceptedInstructions({
        ...record().roles[0]!,
        instructions: [instruction({ kind: "word_limit", value, text })],
      }).wordLimit;

    expect(limitOf("100", "Write at least 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("2", "Max 2 pages")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("120", "Max 120")).toBe(120);
    expect(limitOf("150", "Keep it under 150 words")).toBe(150);
  });

  it("takes the smallest most in words, skipping every least", () => {
    const limitOf = (text: string) =>
      acceptedInstructions({
        ...record().roles[0]!,
        instructions: [instruction({ kind: "word_limit", value: "", text })],
      }).wordLimit;

    expect(limitOf("Min 50 words, max 120 words")).toBe(120);
    expect(limitOf("100 words minimum")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("Not less than 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("More than 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("Min: 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("No more than 100 words")).toBe(100);
  });

  it("reads a bare number as the limit before any words in the text, and never a least as a most", () => {
    const limitOf = (value: string, text = "") =>
      acceptedInstructions({
        ...record().roles[0]!,
        instructions: [instruction({ kind: "word_limit", value, text })],
      }).wordLimit;

    expect(limitOf("120", "Max 120; answers 50 words each")).toBe(120);
    expect(limitOf("", "Keep the email to 90 words.")).toBe(90);
    expect(limitOf("at least 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("A minimum of 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("min. 100 words")).toBe(BODY_WORD_LIMIT);
    expect(limitOf("", "No fewer than 100 words, please.")).toBe(BODY_WORD_LIMIT);
  });

  it("takes a keyword as it shows: what shows nothing goes, and an unusual space is a plain one", () => {
    const keywordOf = (value: string) =>
      acceptedInstructions({
        ...record().roles[0]!,
        instructions: [instruction({ kind: "include_keyword", value })],
      }).keyword;
    const char = (code: number) => String.fromCodePoint(code);

    expect(keywordOf(`Uni${char(0x200b)}corn`)).toBe("Unicorn");
    expect(keywordOf(`Uni${char(0x034f)}corn`)).toBe("Unicorn");
    expect(keywordOf(`Machine${char(0xa0)}Learning`)).toBe("Machine Learning");
  });

  it("keeps the 180-word limit when the post allows more, and refuses a keyword that is a link, too long or on two lines", () => {
    const base = record().roles[0]!;
    const keywords = [
      "see https://example.com",
      "www.example.com",
      "evil.co/x",
      "x".repeat(41),
      `two${String.fromCharCode(10)}lines`,
    ];
    for (const value of keywords) {
      const role: Role = {
        ...base,
        instructions: [
          instruction({ kind: "word_limit", value: "300 words" }),
          instruction({ kind: "include_keyword", value }),
        ],
      };
      expect(acceptedInstructions(role)).toEqual({
        subjectFormat: null,
        wordLimit: BODY_WORD_LIMIT,
        keyword: null,
      });
    }
  });
});

describe("subjectFor", () => {
  it("is Application: {Role} – {Name} without an accepted format", () => {
    expect(subjectFor(null, "Sam Rivera", "Senior Full-Stack Engineer")).toBe(
      "Application: Senior Full-Stack Engineer – Sam Rivera",
    );
  });

  it("fills in only {name} and {role}", () => {
    expect(subjectFor("{role} | {name} | {company} {x}", "Sam Rivera", "Engineer")).toBe(
      "Engineer | Sam Rivera | {company} {x}",
    );
  });

  it('fills in a title holding "$&" or "$\'" as plain text', () => {
    expect(subjectFor("{role} – {name}", "Sam", "C$$ & $& Dev $'")).toBe("C$$ & $& Dev $' – Sam");
  });

  it("drops direction marks, which would make the subject read otherwise than it is sent", () => {
    const override = String.fromCharCode(0x202e);
    expect(subjectFor(null, "Sam", `Engineer${override}reganaM`)).toBe(
      "Application: EngineerreganaM – Sam",
    );
  });

  it("drops every format character, keeping only a joiner inside an emoji", () => {
    const marks = [0x200e, 0x200f, 0x061c, 0x200b, 0xfeff, 0x2060].map((code) =>
      String.fromCodePoint(code),
    );
    expect(oneLine(`Sen${marks.join("")}ior`)).toBe("Senior");
    const joiner = String.fromCodePoint(0x200d);
    const family = [0x1f468, 0x1f469, 0x1f467]
      .map((code) => String.fromCodePoint(code))
      .join(joiner);
    expect(oneLine(`Team ${family}`)).toBe(`Team ${family}`);
    expect(oneLine(`Uni${joiner}corn`)).toBe("Unicorn");
  });

  it("drops what shows nothing and makes every space plain, keeping what an emoji needs", () => {
    const char = (code: number) => String.fromCodePoint(code);
    expect(oneLine(`a${char(0x034f)}b${char(0x3164)}c${char(0xad)}d${char(0xe0041)}e`)).toBe(
      "abcde",
    );
    expect(oneLine(`Senior${char(0xa0)}Engineer${char(0x202f)}role`)).toBe("Senior Engineer role");
    const heart = `${char(0x2764)}${char(0xfe0f)}`;
    expect(oneLine(`Thanks ${heart}`)).toBe(`Thanks ${heart}`);
    expect(oneLine(`plain${char(0xfe0f)}text`)).toBe("plaintext");
  });

  it("never carries a line break, however the format tries", () => {
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const subject = subjectFor(
      `Application {name}${cr}${lf} Bcc: x@evil.com`,
      "Sam Rivera",
      "Engineer",
    );

    expect(subject).toBe("Application Sam Rivera Bcc: x@evil.com");
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subjectFor(null, "Sam Rivera", `Engineer${lf}Bcc: x@evil.com`)).not.toMatch(/[\r\n]/);
  });
});

describe("greetingFor", () => {
  it("greets the recruiter the post names, and otherwise the hiring team", () => {
    expect(greetingFor("Ayesha Khan")).toBe("Dear Ayesha Khan,");
    expect(greetingFor("  ")).toBe(DEFAULT_GREETING);
    expect(greetingFor(`Ayesha${String.fromCharCode(10)}Khan`)).toBe("Dear Ayesha Khan,");
  });
});

describe("gapLine", () => {
  const requirement = (skills: string[]) => ({
    id: "R9",
    text: "Kubernetes",
    priority: "must" as const,
    kind: "skill" as const,
    skills,
    depth: "production" as const,
    years: -1,
  });
  const choice = (overrides: Partial<Parameters<typeof gapLine>[1]> = {}) => ({
    requirementId: "R9",
    knownLineId: "",
    templateId: "",
    relatedFactId: "",
    ...overrides,
  });

  it("uses a known gap line only for a requirement naming one of its skills, aliases included", () => {
    expect(gapLine(requirement(["k8s"]), choice({ knownLineId: "K-kubernetes" }), profile)).toBe(
      "I haven't run Kubernetes in production; I deploy containers with Docker.",
    );
    expect(gapLine(requirement(["aws"]), choice({ knownLineId: "K-kubernetes" }), profile)).toBe(
      NEEDS_YOUR_LINE,
    );
  });

  it("names in a template the first skill no approved fact has, never one the profile shows", () => {
    const either = requirement(["docker", "kubernetes"]);

    expect(gapLine(either, choice({ templateId: "G-learning" }), profile)).toBe(
      "I am learning Kubernetes now.",
    );
    expect(gapLine(requirement(["docker"]), choice({ templateId: "G-learning" }), profile)).toBe(
      NEEDS_YOUR_LINE,
    );
  });

  it("builds no template line for a degree, a language or another requirement", () => {
    for (const kind of ["education", "language", "other"] as const) {
      expect(
        gapLine(
          { ...requirement(["arabic"]), kind },
          choice({ templateId: "G-learning" }),
          profile,
        ),
      ).toBe(NEEDS_YOUR_LINE);
    }
  });

  it("uses a known gap line verbatim", () => {
    expect(
      gapLine(requirement(["kubernetes"]), choice({ knownLineId: "K-kubernetes" }), profile),
    ).toBe("I haven't run Kubernetes in production; I deploy containers with Docker.");
  });

  it("fills a template with the skill's display name and the related fact's phrase", () => {
    expect(
      gapLine(
        requirement(["kubernetes"]),
        choice({ templateId: "G-not-professional", relatedFactId: "F-docker" }),
        profile,
      ),
    ).toBe(
      "I haven't used Kubernetes professionally; the closest is Docker deployments on managed platforms.",
    );
    expect(gapLine(requirement(["nextjs"]), choice({ templateId: "G-learning" }), profile)).toBe(
      "I am learning Next.js now.",
    );
  });

  it("needs the owner's line for a requirement with no skill, or a choice naming nothing the profile has", () => {
    expect(
      gapLine(
        requirement([]),
        choice({ templateId: "G-not-professional", relatedFactId: "F-docker" }),
        profile,
      ),
    ).toBe(NEEDS_YOUR_LINE);
    expect(gapLine(requirement(["kubernetes"]), choice({ templateId: "G-unknown" }), profile)).toBe(
      NEEDS_YOUR_LINE,
    );
    expect(
      gapLine(
        requirement(["kubernetes"]),
        choice({ templateId: "G-not-professional", relatedFactId: "F-gone" }),
        profile,
      ),
    ).toBe(NEEDS_YOUR_LINE);
    expect(gapLine(requirement(["kubernetes"]), choice({ knownLineId: "K-gone" }), profile)).toBe(
      NEEDS_YOUR_LINE,
    );
  });
});

describe("buildEmailKit", () => {
  it("keeps no line choice on a gap code could not write, which makes it the owner's", () => {
    const answer: DraftAnswer = {
      fit: [],
      blocks: [
        {
          id: "S1",
          text: "",
          paragraph_break: false,
          class: "gap",
          fact_ids: [],
          fields: [],
          gap: {
            requirement_id: "R4",
            known_line_id: "K-gone",
            template_id: "",
            related_fact_id: "F-docker",
          },
        },
      ],
    };
    const source = record();

    const { kit } = buildEmailKit(answer, {
      record: source,
      role: source.roles[0]!,
      ownerName: "Sam Rivera",
      accepted: { subjectFormat: null, wordLimit: BODY_WORD_LIMIT, keyword: null },
      profile,
    });

    expect(kit.blocks[0]).toMatchObject({
      text: NEEDS_YOUR_LINE,
      gap: { requirementId: "R4", knownLineId: "", templateId: "", relatedFactId: "" },
    });
  });

  it("keeps the model's blocks, writes the gap lines itself, and adds the parts code writes, with no signature", () => {
    const answer: DraftAnswer = {
      fit: [{ requirement_id: "R1", verdict: "met", fact_ids: ["F-docker"], note: "close" }],
      blocks: [
        {
          id: "S1",
          text: `I would like to apply.${String.fromCharCode(10)}`,
          paragraph_break: true,
          class: "courtesy",
          fact_ids: [],
          fields: [],
          gap: { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" },
        },
        {
          id: "S9",
          text: "The model's own wording, which code replaces.",
          paragraph_break: false,
          class: "gap",
          fact_ids: [],
          fields: [],
          gap: {
            requirement_id: "R5",
            known_line_id: "K-kubernetes",
            template_id: "",
            related_fact_id: "",
          },
        },
      ],
    };
    const source = record();
    const role: Role = {
      ...source.roles[0]!,
      requirements: [
        ...source.roles[0]!.requirements,
        {
          id: "R5",
          text: "Kubernetes in production",
          priority: "must",
          kind: "skill",
          skills: ["k8s"],
          depth: "production",
          years: -1,
        },
      ],
    };

    const { kit, fit } = buildEmailKit(answer, {
      record: source,
      role,
      ownerName: "Sam Rivera",
      accepted: { subjectFormat: null, wordLimit: 180, keyword: null },
      profile,
    });

    expect(kit.subject).toBe(`Application: ${source.roles[0]!.title} – Sam Rivera`);
    expect(kit.greeting).toBe(DEFAULT_GREETING);
    expect(kit.closing).toBe(CLOSING);
    expect(kit.blocks.map((block) => block.text)).toEqual([
      "I would like to apply.",
      "I haven't run Kubernetes in production; I deploy containers with Docker.",
    ]);
    // IDs by position, whatever the model numbered them.
    expect(kit.blocks.map((block) => block.id)).toEqual(["S1", "S2"]);
    expect(kit.blocks[0]!.gap).toBeNull();
    expect(kit.blocks[1]!.gap).toEqual({
      requirementId: "R5",
      knownLineId: "K-kubernetes",
      templateId: "",
      relatedFactId: "",
    });
    expect(JSON.stringify(kit)).not.toContain("Portfolio");
    expect(fit).toEqual([
      { requirementId: "R1", verdict: "met", factIds: ["F-docker"], note: "close" },
    ]);
  });
});
