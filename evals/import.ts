import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import PostalMime, { type Email } from "postal-mime";
import { parse } from "yaml";

/**
 * The archive import (evals spec, "Case sources"): a Gmail Takeout mbox of
 * sent mail becomes one case folder per application, `<archive>/<case
 * id>/email.eml`, for the owner to add the post's screenshots to. Only
 * messages Gmail labels Sent with the CV attached are kept; a message whose
 * body holds one of the profile's style examples is left out, so the
 * drafter is never scored on an email it was shown as a model (amendment
 * A10). A message that cannot be read is reported and passed over. A case
 * already in the archive is not written again.
 */

export type SkipReason = "not_sent" | "no_resume" | "style_example";

export type ImportOutcome =
  | { kind: "case"; id: string; subject: string }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "malformed"; error: string };

export interface ImportOptions {
  /** The CV's file name as sent, matched in any case: "resume.pdf". */
  attachment: string;
  /** The profile's style examples, as text. */
  styleExamples: readonly string[];
}

export interface ImportReport {
  cases: { id: string; subject: string }[];
  skipped: Record<SkipReason, number>;
  /** Each malformed message by its place in the file (1 for the first) and why. */
  malformed: { index: number; error: string }[];
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
function normalised(text: string): string {
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

/** A case's ID: the day it was sent and a hash of its message ID, the same on every import. */
function caseId(email: Email, raw: Uint8Array): string {
  const sent = new Date(email.date ?? "");
  const day = Number.isNaN(sent.getTime()) ? "undated" : sent.toISOString().slice(0, 10);
  const key = email.messageId?.trim() || Buffer.from(raw).toString("latin1");
  return `${day}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/** What the import makes of one message. */
export async function judgeMessage(
  raw: Uint8Array,
  options: ImportOptions,
): Promise<ImportOutcome> {
  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch (error) {
    return { kind: "malformed", error: error instanceof Error ? error.message : String(error) };
  }
  if (email.headers.length === 0) return { kind: "malformed", error: "no headers" };
  const labels = email.headers.find((header) => header.key === "x-gmail-labels")?.value ?? "";
  if (!labels.split(",").some((label) => label.trim().toLowerCase() === "sent")) {
    return { kind: "skipped", reason: "not_sent" };
  }
  const wanted = options.attachment.trim().toLowerCase();
  if (!email.attachments.some((part) => (part.filename ?? "").trim().toLowerCase() === wanted)) {
    return { kind: "skipped", reason: "no_resume" };
  }
  const body = normalised(email.text ?? textOfHtml(email.html ?? ""));
  const shown = options.styleExamples
    .map(normalised)
    .some((example) => example.length >= MIN_EXAMPLE_LENGTH && body.includes(example));
  if (shown) return { kind: "skipped", reason: "style_example" };
  return { kind: "case", id: caseId(email, raw), subject: email.subject ?? "" };
}

/** Reads an mbox file message by message, so a Takeout export of any size fits in memory. */
export async function importMbox(
  file: string,
  archive: string,
  options: ImportOptions,
): Promise<ImportReport> {
  const report: ImportReport = {
    cases: [],
    skipped: { not_sent: 0, no_resume: 0, style_example: 0 },
    malformed: [],
    alreadyImported: 0,
  };
  // Latin-1 keeps every byte as one character, so a message's bytes come back exactly.
  const lines = createInterface({
    input: createReadStream(file, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });
  let index = 0;
  for await (const text of mboxMessages(lines)) {
    index++;
    const raw = new Uint8Array(Buffer.from(text, "latin1"));
    const outcome = await judgeMessage(raw, options);
    if (outcome.kind === "malformed") {
      report.malformed.push({ index, error: outcome.error });
    } else if (outcome.kind === "skipped") {
      report.skipped[outcome.reason]++;
    } else {
      const folder = join(archive, outcome.id);
      if (existsSync(folder)) {
        report.alreadyImported++;
        continue;
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "email.eml"), raw);
      report.cases.push({ id: outcome.id, subject: outcome.subject });
    }
  }
  return report;
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
