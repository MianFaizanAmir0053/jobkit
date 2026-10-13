import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  adoptScreenshot,
  archiveFile,
  type Labels,
  listCases,
  POOL,
  poolCandidates,
  readCase,
  saveLabels,
} from "./cases";

/* The case archive the labelling page reads and writes: evals spec, "Labelling" and AC3. */

let archive: string;

const CRLF = "\r\n";
function eml(subject: string, date: string): string {
  return [
    "From: Sam Rivera <sam@example.com>",
    "To: jobs@northwind.example",
    `Subject: ${subject}`,
    `Date: ${date}`,
    "Message-ID: <a@example.com>",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Dear Hiring Team,",
    "I am applying for the role.",
  ].join(CRLF);
}

function mailCase(id: string, subject: string, date: string): void {
  mkdirSync(join(archive, id), { recursive: true });
  writeFileSync(join(archive, id, "email.eml"), eml(subject, date));
}

const LABELS: Labels = {
  company: "Northwind Analytics",
  role: "Senior Engineer",
  route: "email",
  contact: "jobs@northwind.example",
  eligibility: "eligible",
  must: ["4+ years with React"],
  cropShowsContact: true,
};

beforeEach(() => {
  archive = mkdtempSync(join(tmpdir(), "jobkit-cases-"));
});

afterEach(() => {
  rmSync(archive, { recursive: true, force: true });
});

describe("listCases", () => {
  it("lists mail and live cases, test first, each assigned a split once and kept", async () => {
    mailCase("2026-03-16-8282e9a1", "Application - Engineer", "Mon, 16 Mar 2026 10:00:00 +0500");
    mkdirSync(join(archive, "live-2026-10-06-1a2b3c4d"));
    writeFileSync(
      join(archive, "live-2026-10-06-1a2b3c4d", "source.json"),
      JSON.stringify({
        jobId: "1a2b3c4d-0000-4000-8000-000000000000",
        receivedAt: "2026-10-06T09:00:00.000Z",
      }),
    );
    writeFileSync(join(archive, "live-2026-10-06-1a2b3c4d", "post-1.png"), "png");
    mkdirSync(join(archive, POOL));
    mkdirSync(join(archive, "not-a-case"));

    const cases = await listCases(archive);

    expect(
      cases.map(({ id, split, source, title, screenshots, labelled }) => [
        id,
        split,
        source,
        title,
        screenshots,
        labelled,
      ]),
    ).toEqual([
      ["2026-03-16-8282e9a1", "test", "mail", "Application - Engineer", 0, false],
      ["live-2026-10-06-1a2b3c4d", "test", "live", "A job kept from the app", 1, false],
    ]);
    const split = JSON.parse(readFileSync(join(archive, "split.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(split).toEqual({ "2026-03-16-8282e9a1": "test", "live-2026-10-06-1a2b3c4d": "test" });
  });
});

describe("readCase and saveLabels", () => {
  it("reads a sent email, and keeps a test case's pre-labels hidden until its labels are saved", async () => {
    mailCase("2026-03-16-8282e9a1", "Application - Engineer", "Mon, 16 Mar 2026 10:00:00 +0500");
    writeFileSync(join(archive, "2026-03-16-8282e9a1", "prelabels.json"), JSON.stringify(LABELS));

    const before = await readCase(archive, "2026-03-16-8282e9a1");

    expect(before?.split).toBe("test");
    expect(before?.email).toMatchObject({
      subject: "Application - Engineer",
      to: "jobs@northwind.example",
      date: "2026-03-16T05:00:00.000Z",
    });
    expect(before?.email?.text).toContain("I am applying for the role.");
    expect(before?.prelabels).toBeNull();

    saveLabels(archive, "2026-03-16-8282e9a1", LABELS, new Date("2026-10-13T12:00:00Z"));

    const after = await readCase(archive, "2026-03-16-8282e9a1");
    expect(after?.labels).toEqual(LABELS);
    expect(after?.labelled).toBe(true);
    expect(after?.prelabels).toEqual(LABELS);
    expect(
      JSON.parse(readFileSync(join(archive, "2026-03-16-8282e9a1", "labels.json"), "utf8")),
    ).toMatchObject({
      labelledAt: "2026-10-13T12:00:00.000Z",
    });
  });

  it("shows a dev case's pre-labels at once", async () => {
    mailCase("2026-03-16-8282e9a1", "Application", "Mon, 16 Mar 2026 10:00:00 +0500");
    writeFileSync(join(archive, "split.json"), JSON.stringify({ "2026-03-16-8282e9a1": "dev" }));
    writeFileSync(join(archive, "2026-03-16-8282e9a1", "prelabels.json"), JSON.stringify(LABELS));

    expect((await readCase(archive, "2026-03-16-8282e9a1"))?.prelabels).toEqual(LABELS);
  });

  it("refuses labels that do not fit, and any case ID that is not a case's", async () => {
    mailCase("2026-03-16-8282e9a1", "Application", "Mon, 16 Mar 2026 10:00:00 +0500");

    expect(() =>
      saveLabels(
        archive,
        "2026-03-16-8282e9a1",
        { ...LABELS, route: "carrier pigeon" } as unknown as Labels,
        new Date(),
      ),
    ).toThrow();
    expect(() => saveLabels(archive, "../escape", LABELS, new Date())).toThrow();
    expect(await readCase(archive, "../escape")).toBeNull();
    expect(await readCase(archive, "2026-01-01-00000000")).toBeNull();
  });
});

describe("the screenshot pool", () => {
  it("offers screenshots taken within three days before the email, by their names or their files' times", () => {
    mkdirSync(join(archive, POOL));
    for (const name of [
      "Screenshot_20260314-101500.png",
      "Screenshot_2026-03-16-09-00-00-123_com.linkedin.android.jpg",
      "Screenshot_20260301-080000.png",
      "IMG_0001.PNG",
      "notes.txt",
    ]) {
      writeFileSync(join(archive, POOL, name), "image");
    }
    const taken = new Date("2026-03-15T12:00:00Z");
    utimesSync(join(archive, POOL, "IMG_0001.PNG"), taken, taken);

    const offered = poolCandidates(archive, new Date("2026-03-16T10:00:00Z")).map(
      (entry) => entry.file,
    );

    expect(offered).toEqual([
      "Screenshot_20260314-101500.png",
      "IMG_0001.PNG",
      "Screenshot_2026-03-16-09-00-00-123_com.linkedin.android.jpg",
    ]);
  });

  it("moves a screenshot into its case, and serves only images inside the archive", () => {
    mailCase("2026-03-16-8282e9a1", "Application", "Mon, 16 Mar 2026 10:00:00 +0500");
    mkdirSync(join(archive, POOL));
    writeFileSync(join(archive, POOL, "Screenshot_20260314-101500.png"), "image");

    adoptScreenshot(archive, "2026-03-16-8282e9a1", "Screenshot_20260314-101500.png");

    expect(existsSync(join(archive, POOL, "Screenshot_20260314-101500.png"))).toBe(false);
    expect(archiveFile(archive, "2026-03-16-8282e9a1", "Screenshot_20260314-101500.png")).toEqual({
      bytes: new Uint8Array(Buffer.from("image")),
      contentType: "image/png",
    });
    expect(() => adoptScreenshot(archive, "2026-03-16-8282e9a1", "../../secret.png")).toThrow();
    expect(archiveFile(archive, "2026-03-16-8282e9a1", "email.eml")).toBeNull();
    expect(archiveFile(archive, "..", "x.png")).toBeNull();
  });
});
