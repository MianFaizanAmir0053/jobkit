import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import PostalMime, { type Email } from "postal-mime";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The archive import (evals spec, "Case sources"): a Gmail Takeout mbox of
 * sent mail, or a folder of messages downloaded by hand, becomes one case
 * folder per application, `<archive>/<case id>/email.eml`, for the owner
 * to add the post's screenshots to. Only sent messages with the CV attached
 * are kept: in an mbox, those Gmail labels Sent; a downloaded message has
 * no labels, and the owner chose it from Sent. Mail sent from the day
 * jobkit began drafting is left out, since its words may be a model's, and
 * so is a message whose body holds one of the profile's style examples, so
 * the drafter is never scored on an email it was shown as a model
 * (amendment A10); the labelling page checks the examples again. A message
 * that cannot be read is reported and passed over. A case already in the
 * archive is not written again.
 */

export type SkipReason = "not_sent" | "no_resume" | "style_example" | "after_jobkit";

export type ImportOutcome =
  | { kind: "case"; id: string; subject: string }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "malformed"; error: string };

export interface ImportOptions {
  /** The CV's file name as sent, matched in any case: "resume.pdf". */
  attachment: string;
  /** The profile's style examples, as text. */
  styleExamples: readonly string[];
  /** Mail sent from this time on is left out (jobkitFromOf); null leaves none out. */
  jobkitFrom: Date | null;
}

export interface ImportReport {
  cases: { id: string; subject: string }[];
  skipped: Record<SkipReason, number>;
  /** Each malformed message by its place (1 for the first), its file for a downloaded one, and why. */
  malformed: { index: number; file?: string; error: string }[];
  alreadyImported: number;
}

/**
 * The raw text of each message in an mbox file's lines: a message starts
 * after a "From " postmark line, and a line Gmail escaped as ">From " (or
 * ">>From ") loses one ">" (mboxrd). Lines are joined with CRLF, as mail is.
 */
export async function* mboxMessages(lines: AsyncIterable<string>): AsyncGenerator<string> {
  let current: string[] | null = null;
  for await (const line of lines) {
    if (line.startsWith("From ")) {
      if (current) yield current.join("\r\n");
      current = [];
    } else if (current) {
      current.push(/^>+From /.test(line) ? line.slice(1) : line);
    }
  }
  if (current) yield current.join("\r\n");
}

/** Text for comparing bodies: one case, one kind of space, no ends. */
export function normalised(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** An HTML body's words, for a message with no plain-text part. */
function textOfHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** A style example this short could match by chance, so it is not compared. */
const MIN_EXAMPLE_LENGTH = 40;

/** A message's words: its plain text, else its HTML's. */
export function bodyText(email: Email): string {
  return email.text ?? textOfHtml(email.html ?? "");
}

/** Whether a body holds one of the style examples, with case and spacing normalised (A10). */
export function holdsStyleExample(body: string, styleExamples: readonly string[]): boolean {
  const words = normalised(body);
  return styleExamples
    .map(normalised)
    .some((example) => example.length >= MIN_EXAMPLE_LENGTH && words.includes(example));
}

/** A case's ID: the day it was sent and a hash of its message ID, the same on every import. */
function caseId(email: Email, raw: Uint8Array): string {
  const sent = new Date(email.date ?? "");
  const day = Number.isNaN(sent.getTime()) ? "undated" : sent.toISOString().slice(0, 10);
  const key = email.messageId?.trim() || Buffer.from(raw).toString("latin1");
  return `${day}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/**
 * What the import makes of one message. A Takeout message must carry
 * Gmail's Sent label; a downloaded one has none, and is taken as sent.
 */
export async function judgeMessage(
  raw: Uint8Array,
  options: ImportOptions,
  fromTakeout = true,
): Promise<ImportOutcome> {
  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch (error) {
    return { kind: "malformed", error: error instanceof Error ? error.message : String(error) };
  }
  if (email.headers.length === 0) return { kind: "malformed", error: "no headers" };
  const labels = email.headers.find((header) => header.key === "x-gmail-labels")?.value ?? "";
  if (fromTakeout && !labels.split(",").some((label) => label.trim().toLowerCase() === "sent")) {
    return { kind: "skipped", reason: "not_sent" };
  }
  const wanted = options.attachment.trim().toLowerCase();
  if (!email.attachments.some((part) => (part.filename ?? "").trim().toLowerCase() === wanted)) {
    return { kind: "skipped", reason: "no_resume" };
  }
  const sent = new Date(email.date ?? "").getTime();
  if (options.jobkitFrom && sent >= options.jobkitFrom.getTime()) {
    return { kind: "skipped", reason: "after_jobkit" };
  }
  if (holdsStyleExample(bodyText(email), options.styleExamples)) {
    return { kind: "skipped", reason: "style_example" };
  }
  return { kind: "case", id: caseId(email, raw), subject: email.subject ?? "" };
}

function emptyReport(): ImportReport {
  return {
    cases: [],
    skipped: { not_sent: 0, no_resume: 0, style_example: 0, after_jobkit: 0 },
    malformed: [],
    alreadyImported: 0,
  };
}

/** Counts one message's outcome, writing a kept one as a new case unless it is one already. */
function take(
  report: ImportReport,
  archive: string,
  raw: Uint8Array,
  outcome: ImportOutcome,
  where: { index: number; file?: string },
): void {
  if (outcome.kind === "malformed") {
    report.malformed.push({ ...where, error: outcome.error });
  } else if (outcome.kind === "skipped") {
    report.skipped[outcome.reason]++;
  } else {
    const folder = join(archive, outcome.id);
    if (existsSync(folder)) {
      report.alreadyImported++;
      return;
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "email.eml"), raw);
    report.cases.push({ id: outcome.id, subject: outcome.subject });
  }
}

/** Reads an mbox file message by message, so a Takeout export of any size fits in memory. */
export async function importMbox(
  file: string,
  archive: string,
  options: ImportOptions,
): Promise<ImportReport> {
  const report = emptyReport();
  // Latin-1 keeps every byte as one character, so a message's bytes come back exactly.
  const lines = createInterface({
    input: createReadStream(file, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });
  let index = 0;
  for await (const text of mboxMessages(lines)) {
    index++;
    const raw = new Uint8Array(Buffer.from(text, "latin1"));
    take(report, archive, raw, await judgeMessage(raw, options), { index });
  }
  return report;
}

/** Every .eml file in a folder, as Gmail's "Download message" saves one, by the same rules. */
export async function importEmlFolder(
  folder: string,
  archive: string,
  options: ImportOptions,
): Promise<ImportReport> {
  const report = emptyReport();
  const files = readdirSync(folder)
    .filter(
      (file) => extname(file).toLowerCase() === ".eml" && statSync(join(folder, file)).isFile(),
    )
    .sort();
  for (const [i, file] of files.entries()) {
    const raw = new Uint8Array(readFileSync(join(folder, file)));
    take(report, archive, raw, await judgeMessage(raw, options, false), { index: i + 1, file });
  }
  return report;
}

/** The archive's record of when jobkit may have begun drafting the owner's mail. */
export const IMPORT_FILE = "import.json";

const importRecordSchema = z.object({
  jobkitFrom: z.string().refine((text) => !Number.isNaN(Date.parse(text))),
});

/**
 * From when sent mail may be jobkit's drafting, and so a model's words: the
 * day given, else the one an earlier import kept, else this first import's
 * time, since jobkit drafts nothing before the archive is set up. Kept in
 * the archive for every later import.
 */
export function jobkitFromOf(archive: string, given: Date | null, now: Date): Date {
  const file = join(archive, IMPORT_FILE);
  const kept = existsSync(file)
    ? new Date(importRecordSchema.parse(JSON.parse(readFileSync(file, "utf8"))).jobkitFrom)
    : null;
  const from = given ?? kept ?? now;
  mkdirSync(archive, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ jobkitFrom: from.toISOString() }, null, 2)}\n`);
  return from;
}

/**
 * The style examples a profile file lists, read without checking the rest
 * of the profile, which the owner may still be writing. Each problem (no
 * file, no list, an example that cannot be read) is reported, so the
 * import can say which examples it could not leave out.
 */
export function styleExamplesOf(profileFile: string): { examples: string[]; problems: string[] } {
  if (!existsSync(profileFile)) return { examples: [], problems: [`no profile at ${profileFile}`] };
  let listed: unknown;
  try {
    listed = (parse(readFileSync(profileFile, "utf8")) as { style_examples?: unknown } | null)
      ?.style_examples;
  } catch {
    return { examples: [], problems: [`${profileFile} is not readable YAML`] };
  }
  if (!Array.isArray(listed) || listed.length === 0) {
    return { examples: [], problems: [`${profileFile} lists no style examples`] };
  }
  const examples: string[] = [];
  const problems: string[] = [];
  for (const path of listed) {
    const full = typeof path === "string" ? resolve(dirname(profileFile), path) : null;
    if (full && existsSync(full)) examples.push(readFileSync(full, "utf8"));
    else problems.push(`style example ${String(path)} cannot be read`);
  }
  return { examples, problems };
}
