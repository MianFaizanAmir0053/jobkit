import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProfileFile } from "./profileFile";

const SAMPLE_DIR = join(process.cwd(), "evals", "synthetic");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobkit-profile-file-"));
  cpSync(SAMPLE_DIR, dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadProfileFile", () => {
  it("checks the profile with its CV and style examples, named relative to the file", () => {
    expect(loadProfileFile(join(dir, "profile.sample.yaml"))).toMatchObject({ ok: true });
  });

  it("takes a folder named as a file for no file at all", () => {
    rmSync(join(dir, "cv.sample.pdf"));
    mkdirSync(join(dir, "cv.sample.pdf"));

    expect(loadProfileFile(join(dir, "profile.sample.yaml"))).toEqual({
      ok: false,
      problems: [{ line: 17, message: "cv.file: there is no such file" }],
    });
  });

  it("asks for UTF-8 when the file was saved in another encoding", () => {
    const text = readFileSync(join(dir, "profile.sample.yaml"), "utf8");
    writeFileSync(join(dir, "profile.sample.yaml"), Buffer.from(`﻿${text}`, "utf16le"));

    expect(loadProfileFile(join(dir, "profile.sample.yaml"))).toEqual({
      ok: false,
      problems: [{ line: 1, message: "the file is not UTF-8 text; save it as UTF-8" }],
    });
  });
});
