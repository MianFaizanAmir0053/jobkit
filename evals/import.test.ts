import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importMbox, judgeMessage, mboxMessages, styleExamplesOf } from "./import";

/* The archive import: evals AC1. Every message here is made up. */

const CRLF = "\r\n";

/** A sent application as Gmail exports it: a text body and, by default, resume.pdf attached. */
function message(
  overrides: {
    labels?: string;
    attachment?: string | null;
    body?: string;
    id?: string;
    date?: string;
  } = {},
): string {
  const {
    labels = "Sent,Opened",
    attachment = "resume.pdf",
    body = "Dear Hiring Team,\nI am applying for the Senior Engineer role.\nKind regards,\nSam",
    id = "<application-1@example.com>",
    date = "Mon, 16 Mar 2026 10:00:00 +0500",
  } = overrides;
  const parts = [
    "--b1",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
    ...(attachment === null
      ? []
      : [
          "--b1",
          `Content-Type: application/pdf; name="${attachment}"`,
          `Content-Disposition: attachment; filename="${attachment}"`,
          "Content-Transfer-Encoding: base64",
          "",
          "JVBERi0xLjQK",
        ]),
    "--b1--",
  ];
  return [
    "From: Sam Rivera <sam@example.com>",
    "To: jobs@northwind.example",
    "Subject: Application - Senior Engineer",
    `Date: ${date}`,
    `Message-ID: ${id}`,
    `X-Gmail-Labels: ${labels}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    ...parts,
  ].join(CRLF);
}

const raw = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const options = { attachment: "resume.pdf", styleExamples: [] as string[] };

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split(/\r?\n/)) yield line;
}

describe("mboxMessages", () => {
  it("splits at each postmark line, and takes one '>' off an escaped 'From ' line", async () => {
    const mbox = [
      "From 1771234567890@xxx Mon Mar 16 05:00:00 +0000 2026",
      "Subject: one",
      "",
      ">From the start, I wanted this role.",
      ">>From here on",
      "",
      "From 1771234567891@xxx Tue Mar 17 05:00:00 +0000 2026",
      "Subject: two",
      "",
      "Body two",
    ].join("\n");

    const messages: string[] = [];
    for await (const each of mboxMessages(linesOf(mbox))) messages.push(each);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(`${CRLF}From the start, I wanted this role.${CRLF}`);
    expect(messages[0]).toContain(`${CRLF}>From here on`);
    expect(messages[1]).toMatch(/^Subject: two/);
  });

  it("ignores text before the first postmark", async () => {
    const messages: string[] = [];
    for await (const each of mboxMessages(linesOf("stray line\nFrom x\nSubject: a"))) {
      messages.push(each);
    }

    expect(messages).toEqual(["Subject: a"]);
  });
});

describe("judgeMessage", () => {
  it("makes a case of a sent message with resume.pdf attached, named by its date and ID", async () => {
    const outcome = await judgeMessage(raw(message()), options);

    expect(outcome).toMatchObject({
      kind: "case",
      subject: "Application - Senior Engineer",
    });
    expect(outcome.kind === "case" && outcome.id).toMatch(/^2026-03-16-[0-9a-f]{8}$/);
    expect(await judgeMessage(raw(message()), options)).toEqual(outcome);
  });

  it("skips a message not marked Sent, and one without the attachment, in any case of its name", async () => {
    expect(await judgeMessage(raw(message({ labels: "Inbox,Opened" })), options)).toEqual({
      kind: "skipped",
      reason: "not_sent",
    });
    expect(await judgeMessage(raw(message({ attachment: null })), options)).toEqual({
      kind: "skipped",
      reason: "no_resume",
    });
    expect(await judgeMessage(raw(message({ attachment: "CV.pdf" })), options)).toEqual({
      kind: "skipped",
      reason: "no_resume",
    });
    expect((await judgeMessage(raw(message({ attachment: "Resume.PDF" })), options)).kind).toBe(
      "case",
    );
  });

  it("excludes a message whose body holds a style example, however it is spaced", async () => {
    const example = "I am applying for the Senior Engineer role.\n\nKind regards,";

    expect(await judgeMessage(raw(message()), { ...options, styleExamples: [example] })).toEqual({
      kind: "skipped",
      reason: "style_example",
    });
  });

  it("reports a message with no headers as malformed", async () => {
    expect((await judgeMessage(raw(""), options)).kind).toBe("malformed");
  });
});

describe("importMbox", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jobkit-import-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the style examples a profile lists, saying which it cannot", () => {
    writeFileSync(join(dir, "one.txt"), "An example email.");
    writeFileSync(
      join(dir, "profile.yaml"),
      "owner:\n  name: Sam\nstyle_examples:\n  - one.txt\n  - missing.txt\n",
    );

    expect(styleExamplesOf(join(dir, "profile.yaml"))).toEqual({
      examples: ["An example email."],
      problems: ["style example missing.txt cannot be read"],
    });
    expect(styleExamplesOf(join(dir, "none.yaml")).problems).toEqual([
      `no profile at ${join(dir, "none.yaml")}`,
    ]);
  });

  it("writes one case folder per kept message, reports the rest, and imports nothing twice", async () => {
    const mbox = [
      "From 1 Mon Mar 16 05:00:00 +0000 2026",
      message(),
      "",
      "From 2 Tue Mar 17 05:00:00 +0000 2026",
      message({ labels: "Inbox", id: "<received@example.com>" }),
      "",
      "From 3 Wed Mar 18 05:00:00 +0000 2026",
      "",
      "From 4 Thu Mar 19 05:00:00 +0000 2026",
      message({ id: "<application-2@example.com>", date: "Thu, 19 Mar 2026 09:00:00 +0500" }),
      "",
    ].join(CRLF);
    const file = join(dir, "Sent.mbox");
    writeFileSync(file, mbox, "latin1");
    const archive = join(dir, "archive");

    const report = await importMbox(file, archive, options);

    expect(report.cases.map((entry) => entry.id.slice(0, 10))).toEqual([
      "2026-03-16",
      "2026-03-19",
    ]);
    expect(report.skipped).toEqual({ not_sent: 1, no_resume: 0, style_example: 0 });
    expect(report.malformed.map((entry) => entry.index)).toEqual([3]);
    const folders = readdirSync(archive).sort();
    expect(folders).toEqual(report.cases.map((entry) => entry.id).sort());
    const eml = readFileSync(join(archive, folders[0]!, "email.eml"), "latin1");
    expect(eml).toContain("X-Gmail-Labels: Sent,Opened");

    const again = await importMbox(file, archive, options);
    expect(again.cases).toEqual([]);
    expect(again.alreadyImported).toBe(2);
  });
});
