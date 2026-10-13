import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  fixSplit,
  type Labels,
  listCases,
  POOL,
  poolCandidates,
  readCase,
  saveLabels,
} from "./cases";

/* The case archive the labelling page reads and writes: evals spec, "Labelling" and "Splits", AC3. */

// Phones name screenshots by the local time they were taken, which the laptop reads in its own zone.
process.env.TZ = "Asia/Karachi";

let archive: string;

const CRLF = "\r\n";
const SENT = "Mon, 16 Mar 2026 10:00:00 +0500";
const NO_EXAMPLES = { styleExamples: [] };

interface Mail {
  subject?: string;
  id?: string;
  inReplyTo?: string;
  body?: string;
}

function eml({
  subject = "Application - Engineer",
  id = "<a@example.com>",
  inReplyTo,
  body = `Dear Hiring Team,${CRLF}I am applying for the role.`,
}: Mail): string {
  return [
    "From: Sam Rivera <sam@example.com>",
    "To: jobs@northwind.example",
    `Subject: ${subject}`,
    `Date: ${SENT}`,
    `Message-ID: ${id}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join(CRLF);
}

/** A sent email's case, with this many of the post's screenshots matched to it. */
function mailCase(id: string, mail: Mail = {}, screenshots = 1): void {
  mkdirSync(join(archive, id), { recursive: true });
  writeFileSync(join(archive, id, "email.eml"), eml(mail));
  for (let n = 1; n <= screenshots; n++) writeFileSync(join(archive, id, `post-${n}.png`), "image");
}

/** A kept job's case as eval:pull leaves it. */
function liveCase(id: string, files: Record<string, string> = { "post-1.png": "image" }): void {
  mkdirSync(join(archive, id), { recursive: true });
  writeFileSync(
    join(archive, id, "source.json"),
    JSON.stringify({
      jobId: "1a2b3c4d-0000-4000-8000-000000000000",
      receivedAt: "2026-10-06T09:00:00.000Z",
    }),
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(archive, id, name), content);
  }
}

/** Ten mail cases, each a different application. */
function tenCases(): string[] {
  return Array.from({ length: 10 }, (_, i) => {
    const id = `2026-03-01-${(i + 1).toString(16).padStart(8, "0")}`;
    mailCase(id, { subject: `Application ${i + 1}`, id: `<m${i + 1}@example.com>` });
    return id;
  });
}

const splitFile = () =>
  JSON.parse(readFileSync(join(archive, "split.json"), "utf8")) as Record<string, string>;

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
  it("lists mail and live cases, and what it cannot read as a case, without giving any a split", async () => {
    mailCase("2026-03-16-8282e9a1", {}, 0);
    liveCase("live-2026-10-06-1a2b3c4d");
    mkdirSync(join(archive, POOL));
    mkdirSync(join(archive, "Application to Contoso"));
    writeFileSync(join(archive, "Application.eml"), "From: x");

    const { cases, stray } = await listCases(archive, NO_EXAMPLES);

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
      ["2026-03-16-8282e9a1", null, "mail", "Application - Engineer", 0, false],
      ["live-2026-10-06-1a2b3c4d", null, "live", "A job kept from the app", 1, false],
    ]);
    expect(stray).toEqual(["Application to Contoso", "Application.eml"]);
    expect(existsSync(join(archive, "split.json"))).toBe(false);
  });

  it("lists a case whose email cannot be read, with why, and reads the rest", async () => {
    mailCase("2026-03-16-00000001");
    mkdirSync(join(archive, "2026-03-16-00000002", "email.eml"), { recursive: true });

    const { cases } = await listCases(archive, NO_EXAMPLES);

    expect(cases.find((entry) => entry.id === "2026-03-16-00000002")?.problem).toMatch(
      /email\.eml/,
    );
    expect(cases.find((entry) => entry.id === "2026-03-16-00000001")?.problem).toBeNull();
  });

  it("takes two folders of one message as one application", async () => {
    mailCase("2026-03-16-00000001", { subject: "One", id: "<same@example.com>" });
    mailCase("2026-03-17-00000002", { subject: "Two", id: "<same@example.com>", body: "Other." });

    const { cases } = await listCases(archive, NO_EXAMPLES);

    expect(cases.find((entry) => entry.id === "2026-03-16-00000001")?.sameAs).toEqual([
      "2026-03-17-00000002",
    ]);
  });

  it("refuses a split file it cannot read, rather than assigning every case again", async () => {
    mailCase("2026-03-16-00000001");
    writeFileSync(join(archive, "split.json"), "{ half a file");

    await expect(listCases(archive, NO_EXAMPLES)).rejects.toThrow(/split\.json/);
    await expect(fixSplit(archive, NO_EXAMPLES)).rejects.toThrow(/split\.json/);
    writeFileSync(join(archive, "split.json"), JSON.stringify({ "2026-03-16-00000001": "train" }));
    await expect(listCases(archive, NO_EXAMPLES)).rejects.toThrow(/split\.json/);
  });
});

describe("fixSplit", () => {
  const STYLE = "Thank you for considering my application for this position.";

  it("gives a split only to cases ready to label: with screenshots, readable, and no style example", async () => {
    mailCase("2026-03-16-00000001");
    mailCase(
      "2026-03-16-00000002",
      { subject: "Another", id: "<b@example.com>", body: "Other." },
      0,
    );
    liveCase("live-2026-10-06-1a2b3c4d");
    mailCase("2026-03-16-00000003", {
      subject: "Third",
      id: "<c@example.com>",
      body: `Dear team,${CRLF}${STYLE}${CRLF}Sam`,
    });

    const fixed = await fixSplit(archive, { styleExamples: [STYLE] });

    expect(fixed).toEqual({ added: 2, test: 2, dev: 0, waiting: 1, leftOut: 1 });
    expect(splitFile()).toEqual({
      "2026-03-16-00000001": "test",
      "live-2026-10-06-1a2b3c4d": "test",
    });
    expect(readdirSync(archive).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const { cases } = await listCases(archive, { styleExamples: [STYLE] });
    expect(cases.map(({ id, split, leftOut }) => [id, split, leftOut])).toEqual([
      ["2026-03-16-00000001", "test", false],
      ["live-2026-10-06-1a2b3c4d", "test", false],
      ["2026-03-16-00000002", null, false],
      ["2026-03-16-00000003", null, true],
    ]);
  });

  it("keeps every split it gave, and fills a place a deleted test case left with a new case", async () => {
    const first = tenCases();
    await fixSplit(archive, NO_EXAMPLES);
    rmSync(join(archive, first[0]!), { recursive: true });
    mailCase("2026-03-20-0000000b", { subject: "Application 11", id: "<m11@example.com>" });
    mailCase("2026-03-20-0000000c", { subject: "Application 12", id: "<m12@example.com>" });

    const fixed = await fixSplit(archive, NO_EXAMPLES);

    expect(fixed).toMatchObject({ added: 2, test: 10, dev: 1 });
    for (const id of first.slice(1)) expect(splitFile()[id]).toBe("test");
  });

  it("gives a resend, or a reply in its thread, the split of the email it repeats, and names them", async () => {
    const nine = tenCases().slice(0, 9);
    rmSync(join(archive, "2026-03-01-0000000a"), { recursive: true });
    writeFileSync(
      join(archive, "split.json"),
      JSON.stringify(Object.fromEntries(nine.map((id) => [id, "test"]))),
    );
    mailCase("2026-03-16-00000001", {
      subject: "Application - Engineer",
      id: "<first@example.com>",
    });
    mailCase("2026-03-17-00000002", {
      subject: "Application - Engineer",
      id: "<again@example.com>",
    });
    mailCase("2026-03-18-00000003", {
      subject: "Re: Application - Engineer",
      id: "<reply@example.com>",
      inReplyTo: "<first@example.com>",
      body: "Attached again, as asked.",
    });
    mailCase("2026-03-19-00000004", { subject: "Designer", id: "<d@example.com>", body: "Other." });

    await fixSplit(archive, NO_EXAMPLES);

    // The three are one application: they cannot fit in the one test place left.
    expect(splitFile()).toMatchObject({
      "2026-03-16-00000001": "dev",
      "2026-03-17-00000002": "dev",
      "2026-03-18-00000003": "dev",
      "2026-03-19-00000004": "test",
    });
    const { cases } = await listCases(archive, NO_EXAMPLES);
    const sameAs = (id: string) => cases.find((entry) => entry.id === id)?.sameAs;
    expect(sameAs("2026-03-16-00000001")).toEqual(["2026-03-17-00000002", "2026-03-18-00000003"]);
    expect(sameAs("2026-03-19-00000004")).toEqual([]);
  });
});

describe("readCase and saveLabels", () => {
  it("reads a sent email, and keeps a test case's pre-labels hidden until its labels are saved", async () => {
    mailCase("2026-03-16-8282e9a1");
    writeFileSync(join(archive, "2026-03-16-8282e9a1", "prelabels.json"), JSON.stringify(LABELS));
    await fixSplit(archive, NO_EXAMPLES);

    const before = await readCase(archive, "2026-03-16-8282e9a1", NO_EXAMPLES);

    expect(before?.split).toBe("test");
    expect(before?.email).toMatchObject({
      subject: "Application - Engineer",
      to: "jobs@northwind.example",
      date: "2026-03-16T05:00:00.000Z",
    });
    expect(before?.email?.text).toContain("I am applying for the role.");
    expect(before?.prelabels).toBeNull();

    saveLabels(archive, "2026-03-16-8282e9a1", LABELS, new Date("2026-10-13T12:00:00Z"));

    const after = await readCase(archive, "2026-03-16-8282e9a1", NO_EXAMPLES);
    expect(after?.labels).toEqual(LABELS);
    expect(after?.labelled).toBe(true);
    expect(after?.prelabels).toEqual(LABELS);
    expect(
      JSON.parse(readFileSync(join(archive, "2026-03-16-8282e9a1", "labels.json"), "utf8")),
    ).toMatchObject({
      labelledAt: "2026-10-13T12:00:00.000Z",
    });
  });

  it("shows a dev case's pre-labels at once, and none for a case not yet in a split", async () => {
    mailCase("2026-03-16-8282e9a1");
    mailCase("2026-03-16-00000002", { subject: "Another", id: "<b@example.com>" });
    writeFileSync(join(archive, "split.json"), JSON.stringify({ "2026-03-16-8282e9a1": "dev" }));
    for (const id of ["2026-03-16-8282e9a1", "2026-03-16-00000002"]) {
      writeFileSync(join(archive, id, "prelabels.json"), JSON.stringify(LABELS));
    }

    expect((await readCase(archive, "2026-03-16-8282e9a1", NO_EXAMPLES))?.prelabels).toEqual(
      LABELS,
    );
    expect((await readCase(archive, "2026-03-16-00000002", NO_EXAMPLES))?.prelabels).toBeNull();
  });

  it("shows a kept job's pasted text and crop apart from its screenshots", async () => {
    liveCase("live-2026-10-06-1a2b3c4d", {
      "post-1.png": "image",
      "crop.png": "crop",
      "pasted.txt": "Apply at jobs@example.com",
    });

    const found = await readCase(archive, "live-2026-10-06-1a2b3c4d", NO_EXAMPLES);

    expect(found).toMatchObject({
      screenshotFiles: ["post-1.png"],
      screenshots: 1,
      cropFile: "crop.png",
      pastedText: "Apply at jobs@example.com",
    });
  });

  it("refuses labels that do not fit, and any case ID that is not a case's", async () => {
    mailCase("2026-03-16-8282e9a1");

    expect(() =>
      saveLabels(
        archive,
        "2026-03-16-8282e9a1",
        { ...LABELS, route: "carrier pigeon" } as unknown as Labels,
        new Date(),
      ),
    ).toThrow();
    expect(() => saveLabels(archive, "../escape", LABELS, new Date())).toThrow();
    expect(await readCase(archive, "../escape", NO_EXAMPLES)).toBeNull();
    expect(await readCase(archive, "2026-01-01-00000000", NO_EXAMPLES)).toBeNull();
  });
});

describe("the screenshot pool", () => {
  it("offers screenshots taken within three days before the email, by their names' local time or their files' times", () => {
    mkdirSync(join(archive, POOL));
    for (const name of [
      "Screenshot_20260314-101500.png",
      "Screenshot_2026-03-16-09-00-00-123_com.linkedin.android.jpg",
      // 14:00 in Lahore, an hour before the email went at 15:00 (10:00 UTC).
      "Screenshot_20260316-140000.png",
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
      "Screenshot_20260316-140000.png",
    ]);
  });

  it("moves a screenshot into its case, and serves only images inside the archive", () => {
    mailCase("2026-03-16-8282e9a1", {}, 0);
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
