import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import PostalMime, { type Email } from "postal-mime";
import { z } from "zod";

import { ROUTE_KINDS } from "@/core/extraction/record";

import { bodyText, holdsStyleExample, IMPORT_FILE, normalised } from "./import";
import { assignSplits, type Split } from "./split";

/**
 * The case archive (evals spec, "Case sources", "Labelling" and "Splits"):
 * one folder per case under `private/archive/`, a sent email's (`email.eml`)
 * or a kept job's (`source.json`, with its pasted text and the stored crop
 * of its contact when it had them), with the post's screenshots and, once
 * labelled, `labels.json`. Screenshots not yet matched to a case wait in
 * `_screenshots/`. A case gets its split from `npm run eval:split` once it
 * is ready to label, never from viewing the page, and keeps it in
 * `split.json`. Pre-labels (`prelabels.json`) are shown for a dev case at
 * once, and for any other case only after its own labels are saved, so the
 * blind labels are never shaped by a model (amendment A10). A sent email
 * holding one of the profile's style examples is left out, however late
 * the example was chosen (A10).
 */

/** A case folder's name: a sent email's ("2026-03-16-8282e9a1") or a kept job's ("live-…"). */
export const CASE_ID = /^(?:live-)?(?:\d{4}-\d{2}-\d{2}|undated)-[0-9a-f]{8}$/;

/** The folder of screenshots not yet matched to a case. */
export const POOL = "_screenshots";

const SPLIT_FILE = "split.json";
/** The archive's own files at its top; its own folders start with "_" (the pool, eval:pull's). */
const OWN_FILES = new Set([SPLIT_FILE, IMPORT_FILE]);
const CROP_FILE = "crop.png";
const PASTED_FILE = "pasted.txt";
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
/** Screenshots this long before the email was sent are offered for its case. */
const MATCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export const labelsSchema = z.strictObject({
  company: z.string().trim().max(200),
  role: z.string().trim().max(200),
  route: z.enum(ROUTE_KINDS),
  /** The exact address or number; empty when the route has none. */
  contact: z.string().trim().max(300),
  eligibility: z.enum(["eligible", "unclear", "likely_ineligible"]),
  must: z.array(z.string().trim().min(1).max(300)).max(40),
  /** Whether the stored crop shows the contact; null with no crop to judge. */
  cropShowsContact: z.boolean().nullable(),
});

export type Labels = z.infer<typeof labelsSchema>;

/** The profile's style examples, as text (styleExamplesOf), which leave a sent email out. */
export interface CaseOptions {
  styleExamples: readonly string[];
}

export interface CaseSummary {
  id: string;
  /** Its split; null until `npm run eval:split` gives it one, once it is ready to label. */
  split: Split | null;
  source: "mail" | "live";
  /** When it was sent, or when the job arrived, as ISO; null when unknown. */
  date: string | null;
  title: string;
  /** The post's screenshots: every image in the folder but the crop. */
  screenshots: number;
  labelled: boolean;
  /** Its email holds one of the profile's style examples, so it is never scored (A10). */
  leftOut: boolean;
  /** Other cases that seem the same application: a resend, or a reply in its thread. */
  sameAs: string[];
  /** What in its folder cannot be read; such a case is not ready to label. */
  problem: string | null;
}

export interface CaseDetail extends CaseSummary {
  email: { from: string; to: string; subject: string; date: string | null; text: string } | null;
  screenshotFiles: string[];
  /** The stored crop of a kept job's contact, which the crop label judges; null without one. */
  cropFile: string | null;
  /** A kept job's pasted text; null without any. */
  pastedText: string | null;
  labels: Labels | null;
  /** Pre-labels to start from: for a dev case, or once the case's own labels are saved. */
  prelabels: Labels | null;
}

export interface Archive {
  cases: CaseSummary[];
  /** What at the archive's top is not a case, such as a folder named by hand. */
  stray: string[];
}

export interface SplitReport {
  /** Cases given a split by this run. */
  added: number;
  /** Cases ready to label in each split. */
  test: number;
  dev: number;
  /** Cases not ready to label: no screenshots yet, or a file that cannot be read. */
  waiting: number;
  /** Cases whose email holds a style example. */
  leftOut: number;
}

function isImage(file: string): boolean {
  return Object.hasOwn(IMAGE_TYPES, extname(file).toLowerCase());
}

/** A file name inside one folder: no separators, no "." or "..". */
function isPlainName(file: string): boolean {
  return /^[^\\/]+$/.test(file) && file !== "." && file !== "..";
}

function caseIds(archive: string): string[] {
  if (!existsSync(archive)) return [];
  return readdirSync(archive, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && CASE_ID.test(entry.name))
    .map((entry) => entry.name);
}

const splitSchema = z.record(z.string(), z.enum(["test", "dev"]));

/**
 * The splits given so far. A file that cannot be read stops everything:
 * assigning the cases again could put a case labelled with suggestions in
 * the test set.
 */
function savedSplits(archive: string): Record<string, Split> {
  const file = join(archive, SPLIT_FILE);
  if (!existsSync(file)) return {};
  try {
    return splitSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(
      `${file} cannot be read. Restore it from a backup before labelling or running anything: each case must keep the split it was given.`,
    );
  }
}

/** Writes a file whole: a crash leaves the old one, never half of the new. */
function writeWhole(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** A JSON file checked against its schema; null when there is none, a throw naming it when it does not fit. */
function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} does not hold what it should.`);
  return parsed.data;
}

const sourceSchema = z.object({ jobId: z.string(), receivedAt: z.string() });

/** A labels file as saved, read without what saving adds (labelledAt): z.object drops unknown keys. */
const savedLabelsSchema = z.object(labelsSchema.shape);

/** Message IDs in a header: "<a@x> <b@x>". */
function messageIds(header: string | undefined): string[] {
  return header?.match(/<[^<>\s]+>/g) ?? [];
}

/** A subject without the replies' and forwards' prefixes. */
function bareSubject(subject: string): string {
  return normalised(subject.replace(/^(?:\s*(?:re|fwd?)\s*:)+/i, ""));
}

/** One case's folder as read, before splits and the archive's other cases. */
interface FolderRead {
  id: string;
  source: "mail" | "live";
  email: CaseDetail["email"];
  /** For a sent email: its message ID, those it answers, and its words for spotting a resend. */
  thread: { messageId: string | null; answers: string[]; words: string } | null;
  receivedAt: string | null;
  screenshotFiles: string[];
  cropFile: string | null;
  pastedText: string | null;
  labels: Labels | null;
  prelabels: Labels | null;
  leftOut: boolean;
  problem: string | null;
}

async function readFolder(archive: string, id: string, options: CaseOptions): Promise<FolderRead> {
  const folder = join(archive, id);
  const images = readdirSync(folder).filter(isImage).sort();
  const read: FolderRead = {
    id,
    source: id.startsWith("live-") ? "live" : "mail",
    email: null,
    thread: null,
    receivedAt: null,
    screenshotFiles: images.filter((file) => file !== CROP_FILE),
    cropFile: images.includes(CROP_FILE) ? CROP_FILE : null,
    pastedText: null,
    labels: null,
    prelabels: null,
    leftOut: false,
    problem: null,
  };
  try {
    if (read.source === "mail") {
      const file = join(folder, "email.eml");
      if (!existsSync(file)) throw new Error("There is no email.eml in its folder.");
      let parsed: Email;
      try {
        parsed = await PostalMime.parse(readFileSync(file));
      } catch (error) {
        throw new Error(
          `Its email.eml cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const text = bodyText(parsed);
      const sent = new Date(parsed.date ?? "");
      const name = (address: { name: string; address?: string }) =>
        address.address ? `${address.name} <${address.address}>`.trim() : address.name;
      read.email = {
        from: parsed.from ? name(parsed.from) : "",
        to: (parsed.to ?? []).map((address) => address.address ?? address.name).join(", "),
        subject: parsed.subject ?? "",
        date: Number.isNaN(sent.getTime()) ? null : sent.toISOString(),
        text,
      };
      read.thread = {
        messageId: messageIds(parsed.messageId)[0] ?? null,
        answers: [...messageIds(parsed.inReplyTo), ...messageIds(parsed.references)],
        words: `${bareSubject(parsed.subject ?? "")}\n${normalised(text)}`,
      };
      read.leftOut = holdsStyleExample(text, options.styleExamples);
    } else {
      const source = readJson(join(folder, "source.json"), sourceSchema);
      if (!source) {
        throw new Error("There is no source.json in its folder: pull the job again.");
      }
      read.receivedAt = source.receivedAt;
      const pasted = join(folder, PASTED_FILE);
      read.pastedText = existsSync(pasted) ? readFileSync(pasted, "utf8") : null;
    }
    read.labels = readJson(join(folder, "labels.json"), savedLabelsSchema);
    read.prelabels = readJson(join(folder, "prelabels.json"), savedLabelsSchema);
  } catch (error) {
    read.problem = error instanceof Error ? error.message : String(error);
  }
  return read;
}

/** Ready to label, and so to be given a split: readable, not left out, with the post's screenshots. */
function isReady(read: FolderRead): boolean {
  return read.problem === null && !read.leftOut && read.screenshotFiles.length > 0;
}

/**
 * Each case's application: cases are one when one answers the other's
 * message, or both have the same subject and words, as a resend does.
 * Named by the application's first case ID.
 */
function applicationsOf(reads: readonly FolderRead[]): Map<string, string> {
  const parent = new Map(reads.map((read) => [read.id, read.id]));
  const root = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const unite = (one: string, other: string) => {
    const [first, second] = [root(one), root(other)].sort() as [string, string];
    if (first !== second) parent.set(second, first);
  };
  const byMessage = new Map<string, string>();
  const byWords = new Map<string, string>();
  for (const read of reads) {
    if (!read.thread) continue;
    const { messageId, words } = read.thread;
    const known = messageId ? byMessage.get(messageId) : undefined;
    if (known) unite(known, read.id);
    else if (messageId) byMessage.set(messageId, read.id);
    const same = byWords.get(words);
    if (same) unite(same, read.id);
    else byWords.set(words, read.id);
  }
  for (const read of reads) {
    for (const answered of read.thread?.answers ?? []) {
      const other = byMessage.get(answered);
      if (other) unite(other, read.id);
    }
  }
  return new Map(reads.map((read) => [read.id, root(read.id)]));
}

/** Every case's folder read, and the applications they make. */
async function scan(
  archive: string,
  options: CaseOptions,
): Promise<{ reads: FolderRead[]; applications: Map<string, string> }> {
  const reads: FolderRead[] = [];
  for (const id of caseIds(archive)) reads.push(await readFolder(archive, id, options));
  return { reads, applications: applicationsOf(reads) };
}

function detailOf(
  read: FolderRead,
  split: Split | null,
  applications: ReadonlyMap<string, string>,
): CaseDetail {
  const application = applications.get(read.id);
  return {
    id: read.id,
    split,
    source: read.source,
    date: read.email?.date ?? read.receivedAt,
    title: read.email?.subject || (read.source === "live" ? "A job kept from the app" : read.id),
    screenshots: read.screenshotFiles.length,
    labelled: read.labels !== null,
    leftOut: read.leftOut,
    sameAs: [...applications]
      .filter(([id, of]) => of === application && id !== read.id)
      .map(([id]) => id)
      .sort(),
    problem: read.problem,
    email: read.email,
    screenshotFiles: read.screenshotFiles,
    cropFile: read.cropFile,
    pastedText: read.pastedText,
    labels: read.labels,
    prelabels: split === "dev" || read.labels !== null ? read.prelabels : null,
  };
}

/** What at the archive's top is neither a case nor the archive's own. */
function strayOf(archive: string): string[] {
  if (!existsSync(archive)) return [];
  return readdirSync(archive, { withFileTypes: true })
    .filter(({ name }) => !name.startsWith(".") && !name.startsWith("_"))
    .filter((entry) =>
      entry.isDirectory() ? !CASE_ID.test(entry.name) : !OWN_FILES.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

const ORDER: Readonly<Record<string, number>> = { test: 0, none: 1, dev: 2 };

/** Every case, the test cases first, then those with no split yet, then dev, each by date. */
export async function listCases(archive: string, options: CaseOptions): Promise<Archive> {
  const splits = savedSplits(archive);
  const { reads, applications } = await scan(archive, options);
  const cases = reads.map((read): CaseSummary => {
    const detail = detailOf(read, splits[read.id] ?? null, applications);
    return {
      id: detail.id,
      split: detail.split,
      source: detail.source,
      date: detail.date,
      title: detail.title,
      screenshots: detail.screenshots,
      labelled: detail.labelled,
      leftOut: detail.leftOut,
      sameAs: detail.sameAs,
      problem: detail.problem,
    };
  });
  cases.sort(
    (a, b) =>
      ORDER[a.split ?? "none"]! - ORDER[b.split ?? "none"]! ||
      (a.date ?? "").localeCompare(b.date ?? "") ||
      a.id.localeCompare(b.id),
  );
  return { cases, stray: strayOf(archive) };
}

/** One case, or null for a name that is not a case in the archive. */
export async function readCase(
  archive: string,
  id: string,
  options: CaseOptions,
): Promise<CaseDetail | null> {
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) return null;
  const splits = savedSplits(archive);
  const { reads, applications } = await scan(archive, options);
  const read = reads.find((each) => each.id === id);
  return read ? detailOf(read, splits[id] ?? null, applications) : null;
}

/**
 * Gives a split to every case ready to label that has none (`npm run
 * eval:split`), which the owner runs once the cases they mean to keep have
 * their screenshots, and again for cases that arrive later; the cases of
 * one application share a split.
 */
export async function fixSplit(archive: string, options: CaseOptions): Promise<SplitReport> {
  const saved = savedSplits(archive);
  const { reads, applications } = await scan(archive, options);
  const ready = reads.filter(isReady).map((read) => read.id);
  const splits = assignSplits(ready, saved, (id) => applications.get(id) ?? id);
  const added = Object.keys(splits).filter((id) => !Object.hasOwn(saved, id)).length;
  if (added > 0) {
    const ordered = Object.fromEntries(
      Object.entries(splits).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeWhole(join(archive, SPLIT_FILE), `${JSON.stringify(ordered, null, 2)}\n`);
  }
  return {
    added,
    test: ready.filter((id) => splits[id] === "test").length,
    dev: ready.filter((id) => splits[id] === "dev").length,
    waiting: reads.filter((read) => !read.leftOut && !isReady(read)).length,
    leftOut: reads.filter((read) => read.leftOut).length,
  };
}

/** Saves a case's labels, checked against the schema, with when they were saved. */
export function saveLabels(archive: string, id: string, labels: Labels, at: Date): void {
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) throw new Error(`No case ${id}`);
  const checked = labelsSchema.parse(labels);
  writeFileSync(
    join(archive, id, "labels.json"),
    `${JSON.stringify({ ...checked, labelledAt: at.toISOString() }, null, 2)}\n`,
  );
}

/**
 * When a screenshot was taken: from a phone's file name, which gives the
 * phone's local time and so the laptop's, else the file's time.
 */
function takenAt(folder: string, file: string): Date {
  const match = /(\d{4})-?(\d{2})-?(\d{2})[-_ ]?(\d{2})-?(\d{2})-?(\d{2})/.exec(file);
  if (match) {
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const parsed = new Date(year!, month! - 1, day!, hour!, minute!, second!);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return statSync(join(folder, file)).mtime;
}

/** Screenshots in the pool taken within three days before the email was sent, oldest first. */
export function poolCandidates(
  archive: string,
  sentAt: Date | null,
): { file: string; takenAt: string }[] {
  const folder = join(archive, POOL);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(isImage)
    .map((file) => ({ file, at: takenAt(folder, file) }))
    .filter(
      ({ at }) =>
        sentAt === null ||
        (at.getTime() <= sentAt.getTime() && at.getTime() >= sentAt.getTime() - MATCH_WINDOW_MS),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.file.localeCompare(b.file))
    .map(({ file, at }) => ({ file, takenAt: at.toISOString() }));
}

/** Moves a screenshot from the pool into a case's folder, renamed if the case already has one by that name. */
export function adoptScreenshot(archive: string, id: string, file: string): string {
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) throw new Error(`No case ${id}`);
  if (!isPlainName(file) || !isImage(file)) throw new Error(`Not a screenshot: ${file}`);
  const from = join(archive, POOL, file);
  if (!existsSync(from)) throw new Error(`No screenshot ${file} in the pool`);
  let name = file;
  for (let n = 2; existsSync(join(archive, id, name)) || name === CROP_FILE; n++) {
    name = `${file.slice(0, -extname(file).length)}-${n}${extname(file)}`;
  }
  mkdirSync(join(archive, id), { recursive: true });
  renameSync(from, join(archive, id, name));
  return name;
}

/** An image from a case's folder or the pool, or null for anything else. */
export function archiveFile(
  archive: string,
  folder: string,
  file: string,
): { bytes: Uint8Array; contentType: string } | null {
  if (!(CASE_ID.test(folder) || folder === POOL) || !isPlainName(file) || !isImage(file)) {
    return null;
  }
  const path = join(archive, folder, file);
  if (!existsSync(path)) return null;
  return {
    bytes: new Uint8Array(readFileSync(path)),
    contentType: IMAGE_TYPES[extname(file).toLowerCase()]!,
  };
}
