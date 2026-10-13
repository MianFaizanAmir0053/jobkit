import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
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
  dismissCase,
  fixSplit,
  type Labels,
  listCases,
  POOL,
  poolCandidates,
  readCase,
  saveLabels,
} from "./cases";
import { appendSplitEvents, type SplitEvent } from "./splitFile";

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
  date?: string;
}

function eml({
  subject = "Application - Engineer",
  id = "<a@example.com>",
  inReplyTo,
  body = `Dear Hiring Team,${CRLF}I am applying for the role.`,
  date = SENT,
}: Mail): string {
  return [
    "From: Sam Rivera <sam@example.com>",
    "To: jobs@northwind.example",
    `Subject: ${subject}`,
    `Date: ${date}`,
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

/** Mail cases, each a different application. */
function mailCases(count: number, day = "2026-03-01"): string[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${day}-${(i + 1).toString(16).padStart(8, "0")}`;
    mailCase(id, { subject: `Application ${day} ${i + 1}`, id: `<m${i + 1}-${day}@example.com>` });
    return id;
  });
}

/** The splits the split file gives now, by case. */
const splitFile = (): Record<string, string> => {
  const { log } = JSON.parse(readFileSync(join(archive, "split.json"), "utf8")) as {
    log: SplitEvent[];
  };
  return Object.fromEntries(
    log.flatMap((event) => ("split" in event ? [[event.id, event.split]] : [])),
  );
};

/** Splits given as eval:split gives them, written through the split file's own writer. */
const writeSplits = (splits: Record<string, "test" | "dev">) =>
  appendSplitEvents(
    archive,
    Object.entries(splits).map(([id, split]) => ({ at: "2026-10-01T00:00:00.000Z", id, split })),
  );

const LABELS: Labels = {
  company: "Northwind Analytics",
  role: "Senior Engineer",
  route: "email",
  contact: "jobs@northwind.example",
  eligibility: "eligible",
  must: ["4+ years with React"],
  cropShowsContact: null,
};

beforeEach(() => {
  archive = mkdtempSync(join(tmpdir(), "jobkit-cases-"));
  // The first import keeps the day jobkit began drafting: here, one after every email.
  writeFileSync(
    join(archive, "import.json"),
    JSON.stringify({ jobkitFrom: "2099-01-01T00:00:00.000Z" }),
  );
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

  it("leaves out a whole application when one of its emails holds a style example, quoted or not", async () => {
    const example = "Thank you for considering my application for this position.";
    mailCase("2026-03-16-00000001", {
      id: "<first@example.com>",
      body: `Dear team,${CRLF}${example}`,
    });
    mailCase("2026-03-18-00000002", {
      subject: "Re: Application - Engineer",
      id: "<reply@example.com>",
      inReplyTo: "<first@example.com>",
      body: `Attached again.${CRLF}${CRLF}> Dear team,${CRLF}> Thank you for considering${CRLF}> my application for this position.`,
    });
    mailCase("2026-03-19-00000003", { subject: "Other", id: "<o@example.com>", body: "Other." });

    const { cases } = await listCases(archive, { styleExamples: [example] });

    expect(cases.map(({ id, leftOut }) => [id, leftOut])).toEqual([
      ["2026-03-16-00000001", "style_example"],
      ["2026-03-18-00000002", "style_example"],
      ["2026-03-19-00000003", null],
    ]);
  });

  it("leaves out mail sent from the day jobkit began drafting, which may be a model's words", async () => {
    writeFileSync(
      join(archive, "import.json"),
      JSON.stringify({ jobkitFrom: "2026-03-17T00:00:00.000+05:00" }),
    );
    mailCase("2026-03-16-00000001");
    mailCase("2026-03-18-00000002", {
      subject: "Later",
      id: "<later@example.com>",
      date: "Wed, 18 Mar 2026 10:00:00 +0500",
    });

    const { cases } = await listCases(archive, NO_EXAMPLES);

    expect(cases.map(({ id, leftOut }) => [id, leftOut])).toEqual([
      ["2026-03-16-00000001", null],
      ["2026-03-18-00000002", "after_jobkit"],
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

  it("stops while mail cases are in the archive but the day jobkit began drafting is not", async () => {
    rmSync(join(archive, "import.json"));
    liveCase("live-2026-10-06-1a2b3c4d");
    expect((await listCases(archive, NO_EXAMPLES)).cases).toHaveLength(1);

    mailCase("2026-03-16-00000001");

    await expect(listCases(archive, NO_EXAMPLES)).rejects.toThrow(/import\.json/);
    await expect(fixSplit(archive, NO_EXAMPLES)).rejects.toThrow(/import\.json/);
  });

  it("stops when more than ten cases hold test places", async () => {
    const eleven = mailCases(11);
    writeSplits(Object.fromEntries(eleven.map((id) => [id, "test" as const])));

    await expect(listCases(archive, NO_EXAMPLES)).rejects.toThrow(/11 cases hold test places/);
    await expect(fixSplit(archive, NO_EXAMPLES)).rejects.toThrow(/11 cases hold test places/);
  });

  it("stops when a case's labels name a split the split file lacks or contradicts", async () => {
    mailCase("2026-03-16-00000001");
    mailCase("2026-03-16-00000002", { subject: "Two", id: "<b@example.com>" });
    writeSplits({ "2026-03-16-00000001": "dev" });
    saveLabels(archive, "2026-03-16-00000001", LABELS, new Date("2026-10-13T12:00:00Z"));

    rmSync(join(archive, "split.json"));
    rmSync(join(archive, "split.json.bak"));
    writeSplits({ "2026-03-16-00000001": "test" });
    await expect(listCases(archive, NO_EXAMPLES)).rejects.toThrow(/labels\.json.*dev/);

    rmSync(join(archive, "split.json"));
    rmSync(join(archive, "split.json.bak"));
    writeSplits({ "2026-03-16-00000002": "test" });
    await expect(readCase(archive, "2026-03-16-00000002", NO_EXAMPLES)).rejects.toThrow(
      /labels\.json.*dev/,
    );
  });

  it("does not score a test case whose application turns out to hold a case in dev", async () => {
    mailCase("2026-03-16-00000001", { subject: "One", id: "<a@example.com>" });
    mailCase("2026-03-16-00000002", { subject: "Two", id: "<b@example.com>", body: "Other." });
    writeSplits({ "2026-03-16-00000001": "test", "2026-03-16-00000002": "dev" });
    // A later email links them: it answers the first and repeats the second's words.
    mailCase("2026-03-18-00000003", {
      subject: "Two",
      id: "<c@example.com>",
      inReplyTo: "<a@example.com>",
      body: "Other.",
    });

    const { cases } = await listCases(archive, NO_EXAMPLES);

    expect(cases.find((entry) => entry.id === "2026-03-16-00000001")?.leftOut).toBe("not_blind");
    expect(cases.find((entry) => entry.id === "2026-03-16-00000002")?.leftOut).toBeNull();
  });

  it("names the cases held without a split because their application is in a full test set", async () => {
    const ten = mailCases(10);
    await fixSplit(archive, NO_EXAMPLES);
    // A resend of the first test case: the same subject and words.
    mailCase("2026-03-02-0000000a", {
      subject: "Application 2026-03-01 1",
      id: "<resend@example.com>",
    });

    const { cases } = await listCases(archive, NO_EXAMPLES);

    expect(cases.find((entry) => entry.id === "2026-03-02-0000000a")).toMatchObject({
      split: null,
      held: true,
      sameAs: [ten[0]],
    });
    expect(cases.find((entry) => entry.id === ten[1])?.held).toBe(false);
  });

  it("ignores pre-labels it cannot read, but not labels", async () => {
    mailCase("2026-03-16-00000001");
    writeFileSync(join(archive, "2026-03-16-00000001", "prelabels.json"), '{ "company": 7 }');
    mailCase("2026-03-16-00000002", { subject: "Two", id: "<b@example.com>" });
    writeFileSync(join(archive, "2026-03-16-00000002", "labels.json"), "{ half");

    const { cases } = await listCases(archive, NO_EXAMPLES);
    const problem = (id: string) => cases.find((entry) => entry.id === id)?.problem;

    expect(problem("2026-03-16-00000001")).toBeNull();
    expect(problem("2026-03-16-00000002")).toMatch(/labels\.json/);
  });
});

describe("fixSplit", () => {
  const STYLE = "Thank you for considering my application for this position.";

  it("gives a split only to cases ready to label: with screenshots, readable, and no style example", async () => {
    mailCase("2026-03-16-00000001");
    liveCase("live-2026-10-06-1a2b3c4d");
    liveCase("live-2026-10-07-2b3c4d5e", { "pasted.txt": "Apply at jobs@example.com" });
    mailCase("2026-03-16-00000003", {
      subject: "Third",
      id: "<c@example.com>",
      body: `Dear team,${CRLF}${STYLE}${CRLF}Sam`,
    });

    const fixed = await fixSplit(archive, { styleExamples: [STYLE] });

    expect(fixed).toEqual({
      added: 3,
      test: ["2026-03-16-00000001"],
      dev: 2,
      waiting: 0,
      leftOut: 1,
      held: [],
      released: [],
    });
    expect(splitFile()).toEqual({
      "2026-03-16-00000001": "test",
      // A kept job's owner has seen jobkit's reading of it: its labels can never be blind.
      "live-2026-10-06-1a2b3c4d": "dev",
      "live-2026-10-07-2b3c4d5e": "dev",
    });
    expect(readdirSync(archive).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("will not fill test places while cases still wait for screenshots, unless told to go on", async () => {
    mailCase("2026-03-16-00000001");
    mailCase("2026-03-16-00000002", { subject: "Another", id: "<b@example.com>" }, 0);

    await expect(fixSplit(archive, NO_EXAMPLES)).rejects.toThrow(/1 case.*--partial/);
    expect(existsSync(join(archive, "split.json"))).toBe(false);

    expect(await fixSplit(archive, NO_EXAMPLES, { partial: true })).toMatchObject({
      added: 1,
      waiting: 1,
    });
  });

  it("does not wait for a kept live job, which can never take a test place", async () => {
    mailCase("2026-03-16-00000001");
    liveCase("live-2026-10-06-1a2b3c4d", {});

    expect(await fixSplit(archive, NO_EXAMPLES)).toMatchObject({
      test: ["2026-03-16-00000001"],
      waiting: 1,
    });
  });

  it("keeps every split it gave, and fills a place a deleted test case left with a new case", async () => {
    const first = mailCases(10);
    await fixSplit(archive, NO_EXAMPLES);
    rmSync(join(archive, first[0]!), { recursive: true });
    mailCases(2, "2026-03-20");

    const fixed = await fixSplit(archive, NO_EXAMPLES);

    expect(fixed).toMatchObject({ added: 2, dev: 1 });
    expect(fixed.test).toHaveLength(1);
    for (const id of first.slice(1)) expect(splitFile()[id]).toBe("test");
  });

  it("releases a test case set aside once a later case takes its place, and never scores it again", async () => {
    const first = mailCases(10);
    await fixSplit(archive, NO_EXAMPLES);
    dismissCase(archive, first[0]!);
    mailCases(1, "2026-03-20");

    const fixed = await fixSplit(archive, NO_EXAMPLES);

    expect(fixed.test).toEqual(["2026-03-20-00000001"]);
    expect(fixed.released).toEqual([first[0]]);
    // Moved back by hand, it is left out, and test still holds ten.
    renameSync(join(archive, "_dismissed", first[0]!), join(archive, first[0]!));
    const { cases } = await listCases(archive, NO_EXAMPLES);
    expect(cases.find((entry) => entry.id === first[0])?.leftOut).toBe("released");
    expect(cases.filter((entry) => entry.split === "test" && !entry.leftOut)).toHaveLength(10);
  });

  it("keeps out of test an application one of whose cases was in dev, though it was set aside", async () => {
    const ten = mailCases(10);
    await fixSplit(archive, NO_EXAMPLES);
    const [shown, resend] = ["2026-03-16-0000000a", "2026-03-17-0000000b"];
    mailCase(shown, { subject: "Designer at Globex", id: "<a@example.com>", body: "My CV." });
    mailCase(resend, { subject: "Designer at Globex", id: "<b@example.com>", body: "My CV." }, 0);
    await fixSplit(archive, NO_EXAMPLES);
    expect(splitFile()[shown]).toBe("dev");
    // Labelled with its pre-labels shown, then set aside as the extra; a test place frees.
    writeFileSync(join(archive, shown, "prelabels.json"), JSON.stringify(LABELS));
    saveLabels(archive, shown, LABELS, new Date("2026-10-13T12:00:00Z"));
    dismissCase(archive, shown);
    dismissCase(archive, ten[0]!);
    writeFileSync(join(archive, resend, "post-1.png"), "image");

    await fixSplit(archive, NO_EXAMPLES);

    expect(splitFile()[resend]).toBe("dev");
  });

  it("does not wait for a case whose application is already in dev", async () => {
    mailCase("2026-03-16-0000000d", { subject: "Designer", id: "<d@example.com>", body: "CV." });
    writeSplits({ "2026-03-16-0000000d": "dev" });
    mailCase("2026-03-17-0000000e", { subject: "Designer", id: "<e@example.com>", body: "CV." }, 0);
    mailCase("2026-03-18-0000000f", { subject: "Other", id: "<f@example.com>", body: "Other." });

    expect(await fixSplit(archive, NO_EXAMPLES)).toMatchObject({
      test: ["2026-03-18-0000000f"],
      waiting: 1,
    });
  });

  it("takes labels saved without a record of what was shown as labels that cannot be blind", async () => {
    mailCase("2026-03-16-00000001");
    writeFileSync(join(archive, "2026-03-16-00000001", "labels.json"), JSON.stringify(LABELS));

    await fixSplit(archive, NO_EXAMPLES);

    expect(splitFile()).toEqual({ "2026-03-16-00000001": "dev" });
  });

  it("keeps a test case's place while its screenshots are away", async () => {
    const first = mailCases(10);
    await fixSplit(archive, NO_EXAMPLES);
    rmSync(join(archive, first[0]!, "post-1.png"));
    mailCases(1, "2026-03-20");

    const fixed = await fixSplit(archive, NO_EXAMPLES, { partial: true });

    expect(fixed).toMatchObject({ test: [], dev: 1 });
  });

  it("gives a resend, or a reply in its thread, the split of the email it repeats, and names them", async () => {
    const nine = mailCases(9);
    writeSplits(Object.fromEntries(nine.map((id) => [id, "test" as const])));
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

  it("keeps a copy of the split file as it stands, and refuses to begin again while the file is missing", async () => {
    mailCase("2026-03-16-00000001");
    await fixSplit(archive, NO_EXAMPLES);
    mailCase("2026-03-16-00000002", { subject: "Two", id: "<b@example.com>" });
    await fixSplit(archive, NO_EXAMPLES);

    expect(readFileSync(join(archive, "split.json.bak"), "utf8")).toBe(
      readFileSync(join(archive, "split.json"), "utf8"),
    );

    rmSync(join(archive, "split.json"));
    await expect(fixSplit(archive, NO_EXAMPLES)).rejects.toThrow(/split\.json\.bak/);
  });

  it("refuses to begin again when cases were labelled under a split that is gone", async () => {
    mailCase("2026-03-16-00000001");
    writeSplits({ "2026-03-16-00000001": "dev" });
    saveLabels(archive, "2026-03-16-00000001", LABELS, new Date("2026-10-13T12:00:00Z"));
    rmSync(join(archive, "split.json"));
    rmSync(join(archive, "split.json.bak"));

    await expect(fixSplit(archive, NO_EXAMPLES)).rejects.toThrow(/labelled under a split/);
  });
});

describe("readCase and saveLabels", () => {
  it("reads a sent email, and never shows a test case's pre-labels, even after its labels are saved", async () => {
    mailCase("2026-03-16-8282e9a1");
    writeFileSync(join(archive, "2026-03-16-8282e9a1", "prelabels.json"), JSON.stringify(LABELS));
    await fixSplit(archive, NO_EXAMPLES);

    const before = await readCase(archive, "2026-03-16-8282e9a1", NO_EXAMPLES);

    expect(before?.split).toBe("test");
    expect(before?.email).toMatchObject({
      from: "Sam Rivera <sam@example.com>",
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
    expect(after?.prelabels).toBeNull();
  });

  it("keeps with saved labels their split, whether pre-labels were shown, and the crop they judged", async () => {
    liveCase("live-2026-10-06-1a2b3c4d", { "post-1.png": "image", "crop.png": "crop bytes" });
    writeFileSync(
      join(archive, "live-2026-10-06-1a2b3c4d", "prelabels.json"),
      JSON.stringify(LABELS),
    );
    await fixSplit(archive, NO_EXAMPLES);

    saveLabels(
      archive,
      "live-2026-10-06-1a2b3c4d",
      { ...LABELS, cropShowsContact: true },
      new Date("2026-10-13T12:00:00Z"),
    );

    expect(
      JSON.parse(readFileSync(join(archive, "live-2026-10-06-1a2b3c4d", "labels.json"), "utf8")),
    ).toMatchObject({
      labelledAt: "2026-10-13T12:00:00.000Z",
      split: "dev",
      prelabelsShown: true,
      cropSha256: createHash("sha256").update("crop bytes").digest("hex"),
    });
  });

  it("shows a dev case's pre-labels at once, and none for a case not yet in a split", async () => {
    mailCase("2026-03-16-8282e9a1");
    mailCase("2026-03-16-00000002", { subject: "Another", id: "<b@example.com>" });
    writeSplits({ "2026-03-16-8282e9a1": "dev" });
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
    // An email route has an address; and no must-haves is said, never left empty.
    expect(() =>
      saveLabels(archive, "2026-03-16-8282e9a1", { ...LABELS, contact: "" }, new Date()),
    ).toThrow();
    expect(() =>
      saveLabels(archive, "2026-03-16-8282e9a1", { ...LABELS, must: [] }, new Date()),
    ).toThrow();
    saveLabels(archive, "2026-03-16-8282e9a1", { ...LABELS, must: [], noMust: true }, new Date());
    expect(() => saveLabels(archive, "../escape", LABELS, new Date())).toThrow();
    expect(await readCase(archive, "../escape", NO_EXAMPLES)).toBeNull();
    expect(await readCase(archive, "2026-01-01-00000000", NO_EXAMPLES)).toBeNull();
  });
});

describe("dismissCase", () => {
  it("moves a case that is not an application aside, out of the list and its split's count", async () => {
    mailCase("2026-03-16-00000001");
    mailCase("2026-03-16-00000002", { subject: "Two", id: "<b@example.com>" });

    dismissCase(archive, "2026-03-16-00000002");

    expect(existsSync(join(archive, "_dismissed", "2026-03-16-00000002", "email.eml"))).toBe(true);
    expect((await listCases(archive, NO_EXAMPLES)).cases.map((entry) => entry.id)).toEqual([
      "2026-03-16-00000001",
    ]);
    expect(() => dismissCase(archive, "../escape")).toThrow();
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
      // No real time: a run of digits whose parts would roll over.
      "received_10223456789012345.jpeg",
      "notes.txt",
    ]) {
      writeFileSync(join(archive, POOL, name), "image");
    }
    const taken = new Date("2026-03-15T12:00:00Z");
    for (const name of ["IMG_0001.PNG", "received_10223456789012345.jpeg"]) {
      utimesSync(join(archive, POOL, name), taken, taken);
    }

    const offered = poolCandidates(archive, new Date("2026-03-16T10:00:00Z")).map(
      (entry) => entry.file,
    );

    expect(offered).toEqual([
      "Screenshot_20260314-101500.png",
      "IMG_0001.PNG",
      "received_10223456789012345.jpeg",
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
