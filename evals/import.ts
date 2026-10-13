import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import PostalMime, { type Email } from "postal-mime";
import { parse } from "yaml";
import { z } from "zod";

import { knownCaseIds } from "./splitFile";

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
 * archive is not written again, and one the split file names that is no
 * longer in the archive was removed, and is not brought back. Mail left
 * out for a style example is recorded, so the archive leaves out its
 * replies and resends too.
 */

export type SkipReason = "not_sent" | "no_resume" | "style_example" | "after_jobkit";

/**
 * A message the import left out for a style example, as the archive needs
 * it to leave out the rest of its application: its message ID, those it
 * answers, and the SHA-256 of its words, which a resend shares.
 */
export interface LeftOutMail {
  messageId: string | null;
  answers: string[];
  wordsSha256: string;
}

export type ImportOutcome =
  | { kind: "case"; id: string; subject: string }
  | { kind: "skipped"; reason: SkipReason; leftOut?: LeftOutMail }
  | { kind: "malformed"; error: string };

export interface ImportOptions {
  /** The CV's file name as sent, matched in any case: "resume.pdf". */
  attachment: string;
  /** The profile's style examples, as text. */
  styleExamples: readonly string[];
  /** Mail sent from this time on is left out (jobkitFromOf); null leaves none out. */
  jobkitFrom: Date | null;
  /** The owner's address: a downloaded message is taken as sent only when it is from it. */
  owner?: string;
}

export interface ImportReport {
  cases: { id: string; subject: string }[];
  skipped: Record<SkipReason, number>;
  /** Each malformed message by its place (1 for the first), its file for a downloaded one, and why. */
  malformed: { index: number; file?: string; error: string }[];
  alreadyImported: number;
  /** Cases the owner set aside as not applications, which the import does not bring back. */
  dismissed: number;
  /** Cases removed from the archive after they were given a split, which the import does not bring back. */
  removed: number;
  /** Cases whose email.eml was missing or cut short, written again. */
  repaired: number;
  /** The mail left out for a style example, which the import record keeps. */
  leftOut: LeftOutMail[];
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

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** An HTML body's words: its text, with its tags gone and its entities read. */
function textOfHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity);
}

/** A style example this short could match by chance, so it is not compared. */
const MIN_EXAMPLE_LENGTH = 40;

/** A message's words: its plain text, else, when that is empty, its HTML's. */
export function bodyText(email: Email): string {
  return email.text?.trim() ? email.text : textOfHtml(email.html ?? "");
}

/** Each of a message's bodies, plain and HTML, that holds any words. */
export function bodiesOf(email: Email): string[] {
  return [email.text ?? "", textOfHtml(email.html ?? "")].filter((body) => body.trim() !== "");
}

/**
 * A text's words for comparing with a style example, which the owner copies
 * from an email as Gmail shows it: quote marks, links and their addresses,
 * list markers, emphasis and punctuation taken off, case and spacing
 * normalised. Gmail's plain text writes a link as "words <https://…>" and
 * bold as "*words*"; the copied example has the words alone.
 */
export function wordsOf(text: string): string {
  const words = text
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/<(?:https?:|mailto:)[^>\s]*>/gi, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/gm, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return normalised(words);
}

/**
 * Whether a message's bodies hold one of the style examples, word for word
 * (A10): in its plain text or its HTML, quoted in a reply or not.
 */
export function holdsStyleExample(
  bodies: string | readonly string[],
  styleExamples: readonly string[],
): boolean {
  const texts = (typeof bodies === "string" ? [bodies] : bodies).map(
    (body) => ` ${wordsOf(body)} `,
  );
  return styleExamples
    .map(wordsOf)
    .some(
      (example) =>
        example.length >= MIN_EXAMPLE_LENGTH && texts.some((text) => text.includes(` ${example} `)),
    );
}

/** Message IDs in a header: "<a@x> <b@x>". */
function messageIds(header: string | undefined): string[] {
  return header?.match(/<[^<>\s]+>/g) ?? [];
}

/** A subject without the replies' and forwards' prefixes. */
function bareSubject(subject: string): string {
  return normalised(subject.replace(/^(?:\s*(?:re|fwd?)\s*:)+/i, ""));
}

/**
 * Where a sent email sits among the owner's applications: its message ID,
 * those it answers, and its subject and words, which a resend repeats.
 */
export function threadOf(email: Email): {
  messageId: string | null;
  answers: string[];
  words: string;
} {
  return {
    messageId: messageIds(email.messageId)[0] ?? null,
    answers: [...messageIds(email.inReplyTo), ...messageIds(email.references)],
    words: `${bareSubject(email.subject ?? "")}\n${normalised(bodyText(email))}`,
  };
}

/** The SHA-256 of a thread's words, as the import record keeps them. */
export function wordsSha256(words: string): string {
  return createHash("sha256").update(words).digest("hex");
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
 * Gmail's Sent label; a downloaded one has none, and is taken as sent when
 * it is from the owner's address.
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
  const from = email.from?.address?.trim().toLowerCase();
  if (!fromTakeout && options.owner && from !== options.owner.trim().toLowerCase()) {
    return { kind: "skipped", reason: "not_sent" };
  }
  const wanted = options.attachment.trim().toLowerCase();
  if (!email.attachments.some((part) => (part.filename ?? "").trim().toLowerCase() === wanted)) {
    return { kind: "skipped", reason: "no_resume" };
  }
  // Undated mail cannot show it came before jobkit began drafting, so it is left out too.
  const sent = new Date(email.date ?? "").getTime();
  if (options.jobkitFrom && (Number.isNaN(sent) || sent >= options.jobkitFrom.getTime())) {
    return { kind: "skipped", reason: "after_jobkit" };
  }
  if (holdsStyleExample(bodiesOf(email), options.styleExamples)) {
    const thread = threadOf(email);
    return {
      kind: "skipped",
      reason: "style_example",
      leftOut: {
        messageId: thread.messageId,
        answers: thread.answers,
        wordsSha256: wordsSha256(thread.words),
      },
    };
  }
  return { kind: "case", id: caseId(email, raw), subject: email.subject ?? "" };
}

function emptyReport(): ImportReport {
  return {
    cases: [],
    skipped: { not_sent: 0, no_resume: 0, style_example: 0, after_jobkit: 0 },
    malformed: [],
    alreadyImported: 0,
    dismissed: 0,
    removed: 0,
    repaired: 0,
    leftOut: [],
  };
}

/** Where the owner's "Not an application" puts a case, out of the archive's list. */
export const DISMISSED = "_dismissed";

/**
 * Counts one message's outcome, writing a kept one as a new case unless it
 * is one already, was set aside, or was removed after it was given a split
 * (`known`, the cases the split file names); a case whose email.eml is
 * missing, or cut short (the start of this message alone), is written
 * again. A whole copy that differs, as another export's with other labels,
 * is kept as it is. The file is written whole, so an interruption never
 * leaves half of it.
 */
function take(
  report: ImportReport,
  archive: string,
  known: ReadonlySet<string>,
  raw: Uint8Array,
  outcome: ImportOutcome,
  where: { index: number; file?: string },
): void {
  if (outcome.kind === "malformed") {
    report.malformed.push({ ...where, error: outcome.error });
  } else if (outcome.kind === "skipped") {
    report.skipped[outcome.reason]++;
    if (outcome.leftOut) report.leftOut.push(outcome.leftOut);
  } else {
    if (existsSync(join(archive, DISMISSED, outcome.id))) {
      report.dismissed++;
      return;
    }
    const folder = join(archive, outcome.id);
    const file = join(folder, "email.eml");
    const existed = existsSync(folder);
    if (!existed && known.has(outcome.id)) {
      report.removed++;
      return;
    }
    if (existed && existsSync(file)) {
      const kept = readFileSync(file);
      const cutShort =
        kept.length < raw.length && Buffer.compare(kept, raw.subarray(0, kept.length)) === 0;
      if (!cutShort) {
        report.alreadyImported++;
        return;
      }
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${file}.tmp`, raw);
    renameSync(`${file}.tmp`, file);
    if (existed) report.repaired++;
    else report.cases.push({ id: outcome.id, subject: outcome.subject });
  }
}

/** Reads an mbox file message by message, so a Takeout export of any size fits in memory. */
export async function importMbox(
  file: string,
  archive: string,
  options: ImportOptions,
): Promise<ImportReport> {
  const report = emptyReport();
  const known = knownCaseIds(archive);
  // Latin-1 keeps every byte as one character, so a message's bytes come back exactly.
  const lines = createInterface({
    input: createReadStream(file, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });
  let index = 0;
  for await (const text of mboxMessages(lines)) {
    index++;
    const raw = new Uint8Array(Buffer.from(text, "latin1"));
    take(report, archive, known, raw, await judgeMessage(raw, options), { index });
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
  const known = knownCaseIds(archive);
  const files = readdirSync(folder)
    .filter(
      (file) => extname(file).toLowerCase() === ".eml" && statSync(join(folder, file)).isFile(),
    )
    .sort();
  for (const [i, file] of files.entries()) {
    const raw = new Uint8Array(readFileSync(join(folder, file)));
    take(report, archive, known, raw, await judgeMessage(raw, options, false), {
      index: i + 1,
      file,
    });
  }
  return report;
}

/**
 * The archive's import record: from when jobkit may have drafted the
 * owner's mail, and the mail left out for a style example.
 */
export const IMPORT_FILE = "import.json";

const importRecordSchema = z.object({
  jobkitFrom: z.string().refine((text) => !Number.isNaN(Date.parse(text))),
  leftOut: z
    .array(
      z.object({
        messageId: z.string().nullable(),
        answers: z.array(z.string()),
        wordsSha256: z.string(),
      }),
    )
    .optional(),
});

export interface ImportRecord {
  jobkitFrom: Date;
  leftOut: LeftOutMail[];
}

/** The archive's import record, or null before the first import. */
export function importRecordOf(archive: string): ImportRecord | null {
  const file = join(archive, IMPORT_FILE);
  if (!existsSync(file)) return null;
  const record = importRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return { jobkitFrom: new Date(record.jobkitFrom), leftOut: record.leftOut ?? [] };
}

/** The day the archive keeps as jobkit's first drafting, or null before the first import. */
export function keptJobkitFrom(archive: string): Date | null {
  return importRecordOf(archive)?.jobkitFrom ?? null;
}

/**
 * Keeps the import record, written whole: the day, and the mail left out,
 * added to what earlier imports left out, each once.
 */
export function keepImportRecord(archive: string, record: ImportRecord): void {
  const kept = importRecordOf(archive)?.leftOut ?? [];
  const seen = new Set(kept.map((mail) => JSON.stringify(mail)));
  const leftOut = [...kept, ...record.leftOut.filter((mail) => !seen.has(JSON.stringify(mail)))];
  mkdirSync(archive, { recursive: true });
  const file = join(archive, IMPORT_FILE);
  writeFileSync(
    `${file}.tmp`,
    `${JSON.stringify({ jobkitFrom: record.jobkitFrom.toISOString(), leftOut }, null, 2)}\n`,
  );
  renameSync(`${file}.tmp`, file);
}

/**
 * From when sent mail may be jobkit's drafting, and so a model's words. The
 * first import must be told (the day of the first application sent through
 * jobkit, or today if none was), since jobkit may already be in use when
 * the export arrives; later imports keep that day. A later day than the
 * one kept is refused: it would let in mail jobkit drafted. Working the
 * day out writes nothing: the import keeps it (keepImportRecord) once its
 * source has been found.
 */
export function jobkitFromOf(archive: string, given: Date | null): Date {
  const kept = keptJobkitFrom(archive);
  if (!kept && !given) {
    throw new Error(
      "The first import needs --jobkit-from <YYYY-MM-DD>: the day you first sent an application jobkit drafted, or today if you never have.",
    );
  }
  if (kept && given && given.getTime() > kept.getTime()) {
    throw new Error(
      `The archive keeps ${kept.toISOString()} as the day jobkit began drafting; a later day would let in mail it drafted. Give that day or an earlier one.`,
    );
  }
  return given ?? kept!;
}

/** A day as the laptop's midnight: "2026-09-30". A day the calendar does not have is refused. */
export function dayOf(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [year, month, day] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
  const date = match ? new Date(year!, month! - 1, day!) : null;
  if (
    !date ||
    date.getFullYear() !== year ||
    date.getMonth() !== month! - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`--jobkit-from takes a day: YYYY-MM-DD`);
  }
  return date;
}

/** The deepest folder of a path that exists, by its real path, with the rest joined on. */
function realOf(path: string): string {
  const missing: string[] = [];
  let at = resolve(path);
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return resolve(path);
    missing.unshift(at.slice(up.length).replace(/^[\\/]+/, ""));
    at = up;
  }
  return join(realpathSync.native(at), ...missing);
}

/**
 * Whether an archive lies under private/, where git and the commit guard
 * ignore it: by real paths, so a junction or link out of private/ is
 * refused, as are another drive and a network share, which relative()
 * gives back whole.
 */
export function underPrivate(privateDir: string, archive: string): boolean {
  const inside = relative(realOf(privateDir), realOf(archive));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
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
    if (full && existsSync(full) && statSync(full).isFile()) {
      examples.push(readFileSync(full, "utf8"));
    } else {
      problems.push(`style example ${String(path)} cannot be read`);
    }
  }
  return { examples, problems };
}
