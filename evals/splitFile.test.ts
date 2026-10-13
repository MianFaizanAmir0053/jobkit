import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSplitEvents,
  knownCaseIds,
  readSplitRecord,
  SPLIT_COPY,
  SPLIT_FILE,
  type SplitEvent,
} from "./splitFile";

/* The split file: every split given and every place released, kept as a log with a copy (evals spec, "Splits"). */

let archive: string;

const AT = "2026-10-14T10:00:00.000Z";
const [A, B, C] = ["2026-03-16-00000001", "2026-03-16-00000002", "2026-03-16-00000003"];

const fileText = (log: readonly SplitEvent[]) =>
  `${JSON.stringify({ version: 2, log }, null, 2)}\n`;

beforeEach(() => {
  archive = mkdtempSync(join(tmpdir(), "jobkit-split-"));
});

afterEach(() => {
  rmSync(archive, { recursive: true, force: true });
});

describe("the split file", () => {
  it("keeps each split given and each place released, in order, with a copy kept alike", () => {
    appendSplitEvents(archive, [
      { at: AT, id: A, split: "test" },
      { at: AT, id: B, split: "dev" },
    ]);
    appendSplitEvents(archive, [{ at: AT, id: A, release: true }]);

    expect(readSplitRecord(archive)).toEqual({
      assigned: { [A]: "test", [B]: "dev" },
      released: [A],
      log: [
        { at: AT, id: A, split: "test" },
        { at: AT, id: B, split: "dev" },
        { at: AT, id: A, release: true },
      ],
    });
    expect(readFileSync(join(archive, SPLIT_COPY), "utf8")).toBe(
      readFileSync(join(archive, SPLIT_FILE), "utf8"),
    );
    expect(knownCaseIds(archive)).toEqual(new Set([A, B]));
  });

  it("is empty with neither file", () => {
    expect(readSplitRecord(archive)).toBeNull();
    expect(knownCaseIds(archive)).toEqual(new Set());
  });

  it("refuses a missing split file while its copy waits, saying the copy holds every split", () => {
    appendSplitEvents(archive, [{ at: AT, id: A, split: "test" }]);
    rmSync(join(archive, SPLIT_FILE));

    expect(() => readSplitRecord(archive)).toThrow(/split\.json\.bak holds every split/);
  });

  it("refuses a split file that lost splits its copy holds, and one at odds with its copy", () => {
    const log: SplitEvent[] = [
      { at: AT, id: A, split: "test" },
      { at: AT, id: B, split: "dev" },
    ];
    writeFileSync(join(archive, SPLIT_FILE), fileText(log.slice(0, 1)));
    writeFileSync(join(archive, SPLIT_COPY), fileText(log));
    expect(() => readSplitRecord(archive)).toThrow(/split\.json\.bak/);

    writeFileSync(join(archive, SPLIT_COPY), fileText([{ at: AT, id: C, split: "dev" }]));
    expect(() => readSplitRecord(archive)).toThrow(/split\.json\.bak/);
  });

  it("reads on when its copy is one write behind, as a write cut short leaves it, or gone", () => {
    const log: SplitEvent[] = [
      { at: AT, id: A, split: "test" },
      { at: AT, id: B, split: "dev" },
    ];
    writeFileSync(join(archive, SPLIT_FILE), fileText(log));
    writeFileSync(join(archive, SPLIT_COPY), fileText(log.slice(0, 1)));
    expect(readSplitRecord(archive)?.assigned).toEqual({ [A]: "test", [B]: "dev" });

    rmSync(join(archive, SPLIT_COPY));
    expect(readSplitRecord(archive)?.assigned).toEqual({ [A]: "test", [B]: "dev" });
  });

  it("refuses a log that gives a case two splits, or releases a case that was never in test", () => {
    writeFileSync(
      join(archive, SPLIT_FILE),
      fileText([
        { at: AT, id: A, split: "test" },
        { at: AT, id: A, split: "dev" },
      ]),
    );
    expect(() => readSplitRecord(archive)).toThrow(/split\.json/);

    writeFileSync(
      join(archive, SPLIT_FILE),
      fileText([
        { at: AT, id: B, split: "dev" },
        { at: AT, id: B, release: true },
      ]),
    );
    expect(() => readSplitRecord(archive)).toThrow(/split\.json/);
  });

  it("refuses a file it cannot read, or one in the old form, naming the copy", () => {
    writeFileSync(join(archive, SPLIT_FILE), "{ half a file");
    expect(() => readSplitRecord(archive)).toThrow(/split\.json\.bak/);

    writeFileSync(join(archive, SPLIT_FILE), JSON.stringify({ [A]: "test" }));
    expect(() => readSplitRecord(archive)).toThrow(/split\.json/);
  });

  it("writes nothing when a write would break the log", () => {
    appendSplitEvents(archive, [{ at: AT, id: A, split: "test" }]);
    const before = readFileSync(join(archive, SPLIT_FILE), "utf8");

    expect(() => appendSplitEvents(archive, [{ at: AT, id: A, split: "dev" }])).toThrow();
    expect(readFileSync(join(archive, SPLIT_FILE), "utf8")).toBe(before);
  });
});
