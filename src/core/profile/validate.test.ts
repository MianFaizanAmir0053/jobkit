import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type ProfileFiles, validateProfile } from "./validate";

/*
 * The public sample profile (evals/synthetic) is the fixture: it must pass
 * (profile AC6), and each test breaks one thing in a copy of it (AC1).
 */
const SAMPLE_DIR = join(process.cwd(), "evals", "synthetic");
const SAMPLE = readFileSync(join(SAMPLE_DIR, "profile.sample.yaml"), "utf8");

function sampleFiles(overrides: Record<string, Uint8Array | null> = {}): ProfileFiles {
  return {
    read(path) {
      if (path in overrides) return overrides[path]!;
      try {
        return new Uint8Array(readFileSync(join(SAMPLE_DIR, path)));
      } catch {
        return null;
      }
    },
  };
}

/** The 1-based line of the first line containing `needle`, from the line containing `after`. */
function lineOf(text: string, needle: string, after?: string): number {
  const lines = text.split("\n");
  const from = after === undefined ? 0 : lines.findIndex((line) => line.includes(after));
  const index = lines.findIndex((line, i) => i >= from && line.includes(needle));
  if (index < 0) throw new Error(`"${needle}" is not in the text`);
  return index + 1;
}

function problemsOf(text: string, files = sampleFiles()) {
  const result = validateProfile(text, files);
  if (result.ok) throw new Error("expected the profile to be rejected");
  return result.problems;
}

describe("validateProfile", () => {
  it("passes the public sample profile, with its CV and style examples", () => {
    const result = validateProfile(SAMPLE, sampleFiles());

    expect(result).toMatchObject({ ok: true, profile: { owner: { name: "Sam Rivera" } } });
    if (!result.ok) return;
    expect(result.styleExamples).toHaveLength(3);
    expect(new TextDecoder().decode(result.cv.subarray(0, 5))).toBe("%PDF-");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unknown key at its line, without repeating it", () => {
    const text = SAMPLE.replace("  name: Sam Rivera\n", "  name: Sam Rivera\n  nickname: Sammy\n");

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "nickname"), message: "owner: holds a key the profile does not know" },
    ]);
  });

  it("names a misplaced key the profile knows elsewhere", () => {
    const text = SAMPLE.replace(
      "  portfolio: https://portfolio.example.com\n",
      "  portfolio: https://portfolio.example.com\n  city: Lahore\n",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "  city: Lahore"),
        message: "links.city: is not a key the profile knows here",
      },
    ]);
  });

  it("never repeats an answer that an unquoted comma turned into a key", () => {
    const text = SAMPLE.replace(
      'disability: "Prefer not to say" }',
      "disability: Type 1 diabetes, managed }",
    ).replace('PKR: "PKR 900,000 a month" }', "PKR: 950,000 a month }");

    const messages = problemsOf(text).map((problem) => problem.message);

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message).not.toMatch(/diabetes|managed|000 a month|950/);
  });

  it("finds a record key that YAML read as a number", () => {
    const text = SAMPLE.replace(
      "years_per_stack: { react: 5,",
      "years_per_stack: { 3: 4, react: 5,",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "years_per_stack"),
        message:
          "fixed_answers.years_per_stack[key]: is not in the skill vocabulary (src/core/shared/skills.ts)",
      },
    ]);
  });

  it("rejects a duplicate ID at its second use, and a malformed one, in one pass", () => {
    // Facts no email template cites, so only the IDs are wrong.
    const text = SAMPLE.replace("id: F-docker-deploys", "id: F-react-production").replace(
      "id: F-python-side",
      "id: F_python",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "id: F_python"),
        message: "facts[2].id: must look like F-lower-case-words",
      },
      {
        line: lineOf(text, "id: F-react-production", 'statement: "I have built'),
        message: "facts[3].id: is used more than once",
      },
    ]);
  });

  it("rejects a fact without a source or a phrase", () => {
    const text = SAMPLE.replace('    source: "sample CV, Projects"\n', "").replace(
      '    phrase: "five years of production React and Next.js"\n',
      '    phrase: ""\n',
    );

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, 'phrase: ""'), message: "facts[0].phrase: the phrase is empty" },
      { line: lineOf(text, "id: F-python-side"), message: "facts[2].source: is missing" },
    ]);
  });

  it("says a key is missing whatever kind of value it should hold", () => {
    const text = SAMPLE.replace("    kind: experience\n", "");

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "id: F-react-production"), message: "facts[0].kind: is missing" },
    ]);
  });

  it("rejects a skill outside the vocabulary and a place outside the region table", () => {
    const text = SAMPLE.replace("skills: [python, fastapi]", "skills: [python, cobol]").replace(
      "places: [AE]",
      "places: [AE, ATLANTIS]",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "cobol"),
        message: "facts[2].skills[1]: is not in the skill vocabulary (src/core/shared/skills.ts)",
      },
      {
        line: lineOf(text, "ATLANTIS"),
        message:
          "fixed_answers.relocation.places[1]: is not in the region table (src/core/shared/regions.ts)",
      },
    ]);
  });

  it("wants a country, not a region, for where the owner lives", () => {
    const text = SAMPLE.replace("country: PK", "country: SOUTH_ASIA");

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "SOUTH_ASIA"),
        message:
          "owner.location.country: is not a country code in the region table (src/core/shared/regions.ts)",
      },
    ]);
  });

  it("rejects a missing signature", () => {
    const text = SAMPLE.replace(/signature: \|\n(  .*\n)+/, "");

    // A missing key is reported at the start of the map that should hold it.
    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "schema: 1"), message: "signature: is missing" },
    ]);
  });

  it("rejects a CV that is missing, not a PDF, or over 5 MB", () => {
    const line = lineOf(SAMPLE, "file: cv.sample.pdf");
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode("%PDF-"));

    expect(problemsOf(SAMPLE, sampleFiles({ "cv.sample.pdf": null }))).toEqual([
      { line, message: "cv.file: there is no such file" },
    ]);
    expect(
      problemsOf(SAMPLE, sampleFiles({ "cv.sample.pdf": new TextEncoder().encode("hello") })),
    ).toEqual([{ line, message: "cv.file: the CV is not a PDF" }]);
    expect(problemsOf(SAMPLE, sampleFiles({ "cv.sample.pdf": big }))).toEqual([
      { line, message: "cv.file: the CV is larger than 5 MB" },
    ]);
  });

  it("rejects fewer than 3 or more than 5 style examples, or more than 1,500 words in all", () => {
    const two = SAMPLE.replace("  - style/sample-3.txt\n", "");
    const six = SAMPLE.replace(
      "  - style/sample-3.txt\n",
      "  - style/sample-3.txt\n  - style/a.txt\n  - style/b.txt\n  - style/c.txt\n",
    );
    const long = new TextEncoder().encode("word ".repeat(1500));

    expect(problemsOf(two)).toEqual([
      {
        line: lineOf(two, "- style/sample-1.txt"),
        message: "style_examples: needs 3 to 5 style examples",
      },
    ]);
    expect(problemsOf(six)).toContainEqual(
      expect.objectContaining({ message: "style_examples: needs 3 to 5 style examples" }),
    );
    expect(problemsOf(SAMPLE, sampleFiles({ "style/sample-1.txt": long }))).toEqual([
      {
        line: lineOf(SAMPLE, "- style/sample-1.txt"),
        message: expect.stringMatching(
          /^style_examples: the style examples have \d+ words; at most 1500 in total$/,
        ),
      },
    ]);
  });

  it("takes files only from the profile file's folder or below it, each style example once", () => {
    const text = SAMPLE.replace("  - style/sample-1.txt\n", "  - ../.env.local\n")
      .replace("  - style/sample-2.txt\n", "  - C:/Users/someone/tsconfig.json\n")
      .replace("  file: cv.sample.pdf\n", "  file: /etc/cv.pdf\n");
    const repeated = SAMPLE.replace("  - style/sample-2.txt\n", "  - ./style/sample-1.txt\n");
    const outside = "must name a file in the profile file's folder or below it";

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "/etc/cv.pdf"), message: `cv.file: ${outside}` },
      { line: lineOf(text, "../.env.local"), message: `style_examples[0]: ${outside}` },
      { line: lineOf(text, "tsconfig.json"), message: `style_examples[1]: ${outside}` },
    ]);
    expect(problemsOf(repeated)).toEqual([
      {
        line: lineOf(repeated, "./style/sample-1.txt"),
        message: "style_examples[1]: names the same file as an earlier style example",
      },
    ]);
  });

  it("rejects a style example that is not plain UTF-8 text", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    const withNul = new TextEncoder().encode("Hi\u0000there");

    expect(problemsOf(SAMPLE, sampleFiles({ "style/sample-1.txt": utf16 }))).toEqual([
      {
        line: lineOf(SAMPLE, "- style/sample-1.txt"),
        message: "style_examples[0]: is not UTF-8 text; save it as UTF-8",
      },
    ]);
    expect(problemsOf(SAMPLE, sampleFiles({ "style/sample-2.txt": withNul }))).toEqual([
      {
        line: lineOf(SAMPLE, "- style/sample-2.txt"),
        message: "style_examples[1]: holds a control character, so it is not plain text",
      },
    ]);
  });

  it("rejects a control character in any value", () => {
    const text = SAMPLE.replace('notice_period: "One month"', 'notice_period: "One\\0month"');

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "notice_period"),
        message: "fixed_answers.notice_period: holds a control character",
      },
    ]);
  });

  it("rejects a control character in a link, and a broken character anywhere", () => {
    const text = SAMPLE.replace(
      "portfolio: https://portfolio.example.com\n",
      'portfolio: "https://portfolio.example.com/\\e"\n',
    ).replace('notice_period: "One month"', 'notice_period: "One \\uD800 month"');

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "portfolio:"), message: "links.portfolio: holds a control character" },
      {
        line: lineOf(text, "notice_period"),
        message: "fixed_answers.notice_period: holds a broken character",
      },
    ]);
  });

  it("reports a file path holding a control character without trying to read it", () => {
    const text = SAMPLE.replace("  file: cv.sample.pdf\n", '  file: "cv\\0.pdf"\n');
    const read = (path: string) => {
      if (path.includes("\0")) throw new Error(`tried to read ${path}`);
      return sampleFiles().read(path);
    };

    expect(problemsOf(text, { read })).toEqual([
      { line: lineOf(text, "cv\\0.pdf"), message: "cv.file: holds a control character" },
    ]);
  });

  it("reports a file that cannot be read, instead of failing", () => {
    const read = (path: string) => {
      if (path === "style/sample-2.txt")
        throw new Error("EACCES: permission denied, open 'C:/private/style/sample-2.txt'");
      return sampleFiles().read(path);
    };

    expect(problemsOf(SAMPLE, { read })).toEqual([
      {
        line: lineOf(SAMPLE, "- style/sample-2.txt"),
        message: "style_examples[1]: cannot be read",
      },
    ]);
  });

  it("refuses work-authorisation entries whose places overlap with different answers, and unclear regions", () => {
    const text = SAMPLE.replace(
      "    - { place: GB, authorised: false",
      "    - { place: SOUTH_ASIA, authorised: false }\n    - { place: EMEA, authorised: true }\n    - { place: GB, authorised: false",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "SOUTH_ASIA"),
        message:
          "fixed_answers.work_authorisation[2].place: overlaps an earlier entry that answers otherwise",
      },
      {
        line: lineOf(text, "EMEA"),
        message:
          "fixed_answers.work_authorisation[3].place: is a region whose countries are unclear; name countries or a clear region",
      },
    ]);
  });

  it("refuses work-authorisation regions that share a country but answer otherwise, or differ on sponsorship", () => {
    const text = SAMPLE.replace(
      "    - { place: GB, authorised: false",
      [
        "    - { place: NORTH_AMERICA, authorised: true }",
        "    - { place: LATAM, authorised: false }",
        "    - { place: EU, authorised: false, sponsorship_needed: false }",
        "    - { place: DE, authorised: false, sponsorship_needed: true }",
        "    - { place: GB, authorised: false",
      ].join("\n"),
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "NORTH_AMERICA"),
        message:
          "fixed_answers.work_authorisation[2].place: overlaps an earlier entry that answers otherwise",
      },
      {
        line: lineOf(text, "LATAM"),
        message:
          "fixed_answers.work_authorisation[3].place: overlaps an earlier entry that answers otherwise",
      },
      {
        line: lineOf(text, "{ place: DE"),
        message:
          "fixed_answers.work_authorisation[5].place: overlaps an earlier entry that answers otherwise",
      },
    ]);
  });

  it("refuses a relocation place that is a region whose countries are unclear", () => {
    const text = SAMPLE.replace("places: [AE]", "places: [AE, EMEA]");

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "EMEA"),
        message:
          "fixed_answers.relocation.places[1]: is a region whose countries are unclear; name countries or a clear region",
      },
    ]);
  });

  it("refuses a line break in a one-line value, and C1 controls and direction marks in any value", () => {
    const text = SAMPLE.replace("  name: Sam Rivera\n", '  name: "Sam\\nRivera"\n')
      .replace('notice_period: "One month"', 'notice_period: "One\\u0080 month"')
      .replace(
        'availability: "Can start one month after an offer"',
        'availability: "Can start \\u202E soon"',
      );

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "Sam\\nRivera"), message: "owner.name: holds a line break" },
      {
        line: lineOf(text, "notice_period"),
        message: "fixed_answers.notice_period: holds a control character",
      },
      {
        line: lineOf(text, "availability"),
        message: "fixed_answers.availability: holds a direction mark",
      },
    ]);
  });

  it("refuses a link holding a space or a line break, which the URL parser would quietly drop", () => {
    const text = SAMPLE.replace(
      "portfolio: https://portfolio.example.com\n",
      'portfolio: "https://portfolio.example.com/\\nBcc: x"\n',
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "portfolio:"),
        message: "links.portfolio: holds a space or a line break",
      },
    ]);
  });

  it("wants .txt style examples and a .pdf CV, and no stream name in a path", () => {
    const text = SAMPLE.replace("  - style/sample-1.txt\n", "  - profile.sample.yaml\n").replace(
      "  - style/sample-2.txt\n",
      "  - style/sample-2.txt::$DATA\n",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "- profile.sample.yaml"),
        message: "style_examples[0]: must be a .txt file",
      },
      {
        line: lineOf(text, "::$DATA"),
        message: "style_examples[1]: must name a file in the profile file's folder or below it",
      },
    ]);
  });

  it("rejects an empty answer, a working window of no length, and contradictory work authorisation", () => {
    const text = SAMPLE.replace('notice_period: "One month"', 'notice_period: ""')
      .replace('start_utc: "04:00", end_utc: "13:00"', 'start_utc: "04:00", end_utc: "04:00"')
      .replace(
        "- { place: PK, authorised: true }",
        "- { place: PK, authorised: true, sponsorship_needed: true }",
      )
      .replace("- { place: GB, authorised: false", "- { place: PK, authorised: false");

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "notice_period"),
        message: "fixed_answers.notice_period: the notice period is empty",
      },
      {
        line: lineOf(text, "working_window"),
        message: "fixed_answers.working_window.end_utc: is the same as the start",
      },
      {
        line: lineOf(text, "sponsorship_needed: true }"),
        message:
          "fixed_answers.work_authorisation[0].sponsorship_needed: contradicts authorised: true",
      },
      {
        line: lineOf(text, "- { place: PK, authorised: false"),
        message:
          "fixed_answers.work_authorisation[2].place: names the same place as an earlier entry",
      },
    ]);
  });

  it("takes only web links", () => {
    const text = SAMPLE.replace(
      "portfolio: https://portfolio.example.com",
      "portfolio: javascript:alert(1)",
    );

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "javascript:"), message: expect.stringMatching(/^links\.portfolio: /) },
    ]);
  });

  it("rejects a template placeholder other than {skill} and {related}, and an unknown time zone", () => {
    const text = SAMPLE.replace("the closest is {related}", "the closest is {nearest}").replace(
      "timezone: Asia/Karachi",
      "timezone: Asia/Lahore",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "Asia/Lahore"),
        message: "owner.location.timezone: is not a time zone such as Asia/Karachi",
      },
      {
        line: lineOf(text, "{nearest}"),
        message: "gaps.templates[0].text: may use only the placeholders {skill} and {related}",
      },
    ]);
  });

  it.each(["{related.", "{skill}}"])("rejects a template with a stray brace: %j", (broken) => {
    const text = SAMPLE.replace("{related}.", broken);

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "G-not-professional") + 1,
        message: "gaps.templates[0].text: may use only the placeholders {skill} and {related}",
      },
    ]);
  });

  it("takes {company} and {role} alone as an email template's placeholders", () => {
    const text = SAMPLE.replace(
      "I'm writing about the {role} role at {company}.",
      "I'm writing about the {role} role in {team}.",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "{team}"),
        message:
          "email_templates[0].sentences[0].text: may use only the placeholders {company} and {role}",
      },
    ]);
  });

  it("rejects an email template citing a fact the file does not have, or, approved, one waiting", () => {
    const text = SAMPLE.replace(
      '        facts: [F-react-production]\n      - text: "I have also',
      '        facts: [F-no-such-fact]\n      - text: "I have also',
    ).replace("        facts: [F-rag-feature]", "        facts: [F-unapproved-example]");

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "F-no-such-fact"),
        message: "email_templates[0].sentences[1].facts[0]: is not a fact in this file",
      },
      {
        line: lineOf(text, "facts: [F-unapproved-example]"),
        message:
          "email_templates[1].sentences[1].facts[0]: is waiting for approval, so an approved template cannot cite it",
      },
    ]);
  });

  it("lets a template waiting for approval cite a fact waiting too", () => {
    const text = SAMPLE.replace(
      'must never appear in a draft."\n        facts: [F-react-production]',
      'must never appear in a draft."\n        facts: [F-unapproved-example]',
    );

    expect(validateProfile(text, sampleFiles())).toMatchObject({ ok: true });
  });

  it("rejects an email template that cites no fact, or runs past 150 words", () => {
    const long = Array.from({ length: 150 }, () => "word").join(" ");
    const text = SAMPLE.replace(
      '      - text: "I have shipped React and Next.js applications in production for five years."\n        facts: [F-react-production]\n',
      '      - text: "I have shipped React and Next.js applications in production for five years."\n',
    )
      .replace(
        '      - text: "I have also designed and run Node.js REST APIs on PostgreSQL in production."\n        facts: [F-node-apis]\n',
        '      - text: "I have also designed and run Node.js REST APIs on PostgreSQL in production."\n',
      )
      .replace(
        "I build the APIs around such features in Node.js on PostgreSQL.",
        `I build the APIs around such features: ${long}.`,
      );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "id: T-full-stack"),
        message: "email_templates[0]: no sentence cites a fact, so the template claims nothing",
      },
      {
        line: lineOf(text, "id: T-ai-features"),
        // 8, 13, 7 and the 150 added, and 10: the placeholders count as a word each.
        message:
          "email_templates[1]: the template has 188 words; at most 150, so gap lines fit in the email's 180",
      },
    ]);
  });

  it("rejects a duplicate or malformed email template ID", () => {
    const text = SAMPLE.replace("id: T-ai-features", "id: T-full-stack").replace(
      "id: T-waiting",
      "id: t_waiting",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "name: AI features") - 1,
        message: "email_templates[1].id: is used more than once",
      },
      {
        line: lineOf(text, "id: t_waiting"),
        message: "email_templates[2].id: must look like T-lower-case-words",
      },
    ]);
  });

  it.each(["+05:00", "asia/karachi", "EST", "PST8PDT"])("rejects %j as a time zone", (zone) => {
    expect(
      problemsOf(SAMPLE.replace("timezone: Asia/Karachi", `timezone: "${zone}"`)),
    ).toMatchObject([
      { message: "owner.location.timezone: is not a time zone such as Asia/Karachi" },
    ]);
  });

  it("reports a file that is not valid YAML, or repeats a key, at its line", () => {
    const repeated = SAMPLE.replace("schema: 1\n", "schema: 1\nschema: 1\n");

    expect(problemsOf(repeated)).toEqual([
      { line: lineOf(repeated, "schema: 1") + 1, message: "the file repeats a key here" },
    ]);
    expect(problemsOf("owner: [unclosed")).toMatchObject([{ line: 1 }]);
  });

  it("reports a value read as a YAML alias at its line, rather than failing", () => {
    const text = SAMPLE.replace('notice_period: "One month"', "notice_period: *negotiable*");

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "*negotiable*"),
        message: "a value starts with *, which YAML reads as an alias; put the value in quotes",
      },
    ]);
  });

  it("names line 1 for a file with nothing in it", () => {
    expect(problemsOf("")).toEqual([{ line: 1, message: "the file is empty" }]);
    expect(problemsOf("# only a comment\n")).toEqual([{ line: 1, message: "the file is empty" }]);
  });

  it("names the whole file when it is not a map of keys at all", () => {
    expect(problemsOf("just some text\n")).toEqual([
      { line: 1, message: expect.stringMatching(/^the file: /) },
    ]);
  });

  it("never repeats the file's own text in a problem, and stops after a few for a broken file", () => {
    const broken = SAMPLE.replace("timezone: Asia/Karachi }", "timezone: Asia/Karachi }}");
    const placed = SAMPLE.replace("places: [AE]", 'places: ["Pakistan (private note)"]');

    const problems = [...problemsOf(broken), ...problemsOf(placed)];

    expect(problemsOf(broken).length).toBeLessThanOrEqual(5);
    for (const { message } of problems) {
      expect(message).not.toMatch(/WhatsApp|202 555|USD 5,000|Prefer not|private note|Sam Rivera/);
    }
  });

  it("reports every problem in one pass, files included", () => {
    const text = SAMPLE.replace("skills: [docker]", "skills: [dockerr]").replace(
      "relocation: { open: true, places: [AE]",
      "relocation: { open: true, places: [UAE]",
    );

    expect(
      problemsOf(text, sampleFiles({ "style/sample-2.txt": null })).map((p) => p.message),
    ).toEqual([
      "facts[3].skills[0]: is not in the skill vocabulary (src/core/shared/skills.ts)",
      "fixed_answers.relocation.places[0]: is not in the region table (src/core/shared/regions.ts)",
      "style_examples[1]: there is no such file",
    ]);
  });
});

describe("the profile hash", () => {
  it("is the same for the same files, and changes with the CV or a style example", () => {
    const hashOf = (files: ProfileFiles) => {
      const result = validateProfile(SAMPLE, files);
      return result.ok ? result.hash : null;
    };
    const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 ${text}`);

    expect(hashOf(sampleFiles())).toBe(hashOf(sampleFiles()));
    expect(hashOf(sampleFiles({ "cv.sample.pdf": pdf("a") }))).not.toBe(hashOf(sampleFiles()));
    expect(hashOf(sampleFiles({ "style/sample-1.txt": new TextEncoder().encode("Hi.") }))).not.toBe(
      hashOf(sampleFiles()),
    );
  });
});
