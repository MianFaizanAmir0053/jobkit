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

  it("rejects an unknown key at its line", () => {
    const text = SAMPLE.replace("  name: Sam Rivera\n", "  name: Sam Rivera\n  nickname: Sammy\n");

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "nickname"), message: "owner.nickname: is not a key the profile knows" },
    ]);
  });

  it("rejects a duplicate ID at its second use, and a malformed one", () => {
    const text = SAMPLE.replace("id: F-node-apis", "id: F-react-production").replace(
      "id: F-python-side",
      "id: F_python",
    );

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "id: F_python"), message: "facts[2].id: must look like F-lower-case-words" },
    ]);
    const duplicate = SAMPLE.replace("id: F-node-apis", "id: F-react-production");
    expect(problemsOf(duplicate)).toEqual([
      {
        line: lineOf(duplicate, "id: F-react-production", "statement: \"I have built"),
        message: "facts[1].id: F-react-production is used more than once",
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

  it("rejects a skill outside the vocabulary and a place outside the region table", () => {
    const text = SAMPLE.replace("skills: [python, fastapi]", "skills: [python, cobol]").replace(
      "places: [AE]",
      "places: [AE, ATLANTIS]",
    );

    expect(problemsOf(text)).toEqual([
      {
        line: lineOf(text, "cobol"),
        message: "facts[2].skills[1]: cobol is not in the skill vocabulary (src/core/shared/skills.ts)",
      },
      {
        line: lineOf(text, "ATLANTIS"),
        message: "fixed_answers.relocation.places[1]: ATLANTIS is not in the region table (src/core/shared/regions.ts)",
      },
    ]);
  });

  it("rejects a missing signature", () => {
    const text = SAMPLE.replace(
      /signature: \|\n(  .*\n)+/,
      "",
    );

    // A missing key is reported at the start of the map that should hold it.
    expect(problemsOf(text)).toEqual([{ line: lineOf(text, "schema: 1"), message: "signature: is missing" }]);
  });

  it("rejects a CV that is missing, not a PDF, or over 5 MB", () => {
    const line = lineOf(SAMPLE, "file: cv.sample.pdf");
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode("%PDF-"));

    expect(problemsOf(SAMPLE, sampleFiles({ "cv.sample.pdf": null }))).toEqual([
      { line, message: "cv.file: cv.sample.pdf does not exist" },
    ]);
    expect(problemsOf(SAMPLE, sampleFiles({ "cv.sample.pdf": new TextEncoder().encode("hello") }))).toEqual([
      { line, message: "cv.file: the CV is not a PDF" },
    ]);
    expect(problemsOf(SAMPLE, sampleFiles({ "cv.sample.pdf": big }))).toEqual([
      { line, message: "cv.file: the CV is larger than 5 MB" },
    ]);
  });

  it("rejects fewer than 3 or more than 5 style examples, or more than 1,500 words in all", () => {
    const two = SAMPLE.replace("  - style/sample-3.txt\n", "");
    const six = SAMPLE.replace(
      "  - style/sample-3.txt\n",
      "  - style/sample-3.txt\n  - style/sample-1.txt\n  - style/sample-2.txt\n  - style/sample-3.txt\n",
    );
    const long = new TextEncoder().encode("word ".repeat(1500));

    expect(problemsOf(two)).toEqual([
      { line: lineOf(two, "- style/sample-1.txt"), message: "style_examples: needs 3 to 5 style examples" },
    ]);
    expect(problemsOf(six)).toMatchObject([{ message: "style_examples: needs 3 to 5 style examples" }]);
    expect(problemsOf(SAMPLE, sampleFiles({ "style/sample-1.txt": long }))).toEqual([
      {
        line: lineOf(SAMPLE, "- style/sample-1.txt"),
        message: expect.stringMatching(/^style_examples: the style examples have \d+ words; at most 1500 in total$/),
      },
    ]);
  });

  it("rejects a template placeholder other than {skill} and {related}, and an unknown time zone", () => {
    const text = SAMPLE.replace("the closest is {related}", "the closest is {nearest}").replace(
      "timezone: Asia/Karachi",
      "timezone: Asia/Lahore",
    );

    expect(problemsOf(text)).toEqual([
      { line: lineOf(text, "Asia/Lahore"), message: "owner.location.timezone: is not a time zone such as Asia/Karachi" },
      {
        line: lineOf(text, "{nearest}"),
        message: "gaps.templates[0].text: uses {nearest}; templates may use only {skill} and {related}",
      },
    ]);
  });

  it("reports a file that is not valid YAML, or repeats a key, at its line", () => {
    const repeated = SAMPLE.replace("schema: 1\n", "schema: 1\nschema: 1\n");

    expect(problemsOf(repeated)).toEqual([
      { line: lineOf(repeated, "schema: 1") + 1, message: expect.stringContaining("unique") },
    ]);
    expect(problemsOf("owner: [unclosed")).toMatchObject([{ line: 1 }]);
  });

  it("names the whole file when it is not a map of keys at all", () => {
    expect(problemsOf("just some text\n")).toEqual([
      { line: 1, message: expect.stringMatching(/^the file: /) },
    ]);
  });

  it("reports every problem in one pass", () => {
    const text = SAMPLE.replace("skills: [docker]", "skills: [dockerr]").replace(
      "relocation: { open: true, places: [AE]",
      "relocation: { open: true, places: [UAE]",
    );

    expect(problemsOf(text, sampleFiles({ "style/sample-2.txt": null })).map((p) => p.message)).toEqual([
      "facts[3].skills[0]: dockerr is not in the skill vocabulary (src/core/shared/skills.ts)",
      "fixed_answers.relocation.places[0]: UAE is not in the region table (src/core/shared/regions.ts)",
      "style_examples[1]: style/sample-2.txt does not exist",
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
