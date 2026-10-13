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

import PostalMime from "postal-mime";
import { z } from "zod";

import { ROUTE_KINDS } from "@/core/extraction/record";

import { assignSplits, type Split } from "./split";

/**
 * The case archive (evals spec, "Case sources" and "Labelling"): one folder
 * per case under `private/archive/`, a sent email's (`email.eml`) or a kept
 * job's (`source.json`), with its screenshots, and, once labelled,
 * `labels.json`. Screenshots not yet matched to a case wait in `_screenshots/`,
 * and each case's split is kept in `split.json`. Pre-labels (`prelabels.json`)
 * are shown for a dev case at once, and for a test case only after its own
 * labels are saved, so the blind labels are never shaped by a model
 * (amendment A10).
 */

/** A case folder's name: a sent email's ("2026-03-16-8282e9a1") or a kept job's ("live-…"). */
export const CASE_ID = /^(?:live-)?(?:\d{4}-\d{2}-\d{2}|undated)-[0-9a-f]{8}$/;

/** The folder of screenshots not yet matched to a case. */
export const POOL = "_screenshots";

const SPLIT_FILE = "split.json";
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

export interface CaseSummary {
  id: string;
  split: Split;
  source: "mail" | "live";
  /** When it was sent, or when the job arrived, as ISO; null when unknown. */
  date: string | null;
  title: string;
  screenshots: number;
  labelled: boolean;
}

export interface CaseDetail extends CaseSummary {
  email: { from: string; to: string; subject: string; date: string | null; text: string } | null;
  screenshotFiles: string[];
  labels: Labels | null;
  /** Pre-labels to start from: never for a test case before its labels are saved. */
  prelabels: Labels | null;
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

/** Every case's split, assigning the new ones and keeping the assignment. */
function splitsOf(archive: string, ids: readonly string[]): Record<string, Split> {
  const file = join(archive, SPLIT_FILE);
  const saved = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Split>)
    : {};
  const splits = assignSplits(ids, saved);
  if (Object.keys(splits).length !== Object.keys(saved).length) {
    writeFileSync(file, `${JSON.stringify(splits, null, 2)}\n`);
  }
  return splits;
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}

const sourceSchema = z.object({ jobId: z.string(), receivedAt: z.string() });

async function readEmail(folder: string): Promise<CaseDetail["email"]> {
  const file = join(folder, "email.eml");
  if (!existsSync(file)) return null;
  const email = await PostalMime.parse(readFileSync(file));
  const sent = new Date(email.date ?? "");
  const name = (address: { name: string; address?: string }) =>
    address.address ? `${address.name} <${address.address}>`.trim() : address.name;
  return {
    from: email.from ? name(email.from) : "",
    to: (email.to ?? []).map((address) => address.address ?? address.name).join(", "),
    subject: email.subject ?? "",
    date: Number.isNaN(sent.getTime()) ? null : sent.toISOString(),
    text: email.text ?? "",
  };
}

/** A labels file as saved, read without what saving adds (labelledAt): z.object drops unknown keys. */
const savedLabelsSchema = z.object(labelsSchema.shape);

function readLabels(file: string): Labels | null {
  return readJson(file, savedLabelsSchema);
}

async function detailOf(archive: string, id: string, split: Split): Promise<CaseDetail> {
  const folder = join(archive, id);
  const screenshotFiles = readdirSync(folder).filter(isImage).sort();
  const labels = readLabels(join(folder, "labels.json"));
  const prelabels = readLabels(join(folder, "prelabels.json"));
  const email = await readEmail(folder);
  const source = readJson(join(folder, "source.json"), sourceSchema);
  return {
    id,
    split,
    source: email ? "mail" : "live",
    date: email?.date ?? source?.receivedAt ?? null,
    title: email?.subject || (source ? "A job kept from the app" : id),
    screenshots: screenshotFiles.length,
    labelled: labels !== null,
    email,
    screenshotFiles,
    labels,
    prelabels: split === "dev" || labels !== null ? prelabels : null,
  };
}

/** Every case, the test cases first, each by date. */
export async function listCases(archive: string): Promise<CaseSummary[]> {
  const ids = caseIds(archive);
  const splits = splitsOf(archive, ids);
  const cases: CaseSummary[] = [];
  for (const id of ids) {
    const detail = await detailOf(archive, id, splits[id]!);
    cases.push({
      id: detail.id,
      split: detail.split,
      source: detail.source,
      date: detail.date,
      title: detail.title,
      screenshots: detail.screenshots,
      labelled: detail.labelled,
    });
  }
  const order = (split: Split) => (split === "test" ? 0 : 1);
  return cases.sort(
    (a, b) =>
      order(a.split) - order(b.split) ||
      (a.date ?? "").localeCompare(b.date ?? "") ||
      a.id.localeCompare(b.id),
  );
}

/** One case, or null for a name that is not a case in the archive. */
export async function readCase(archive: string, id: string): Promise<CaseDetail | null> {
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) return null;
  const splits = splitsOf(archive, caseIds(archive));
  return detailOf(archive, id, splits[id]!);
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

/** When a screenshot was taken: from a phone's file name, else the file's time. */
function takenAt(folder: string, file: string): Date {
  const match = /(\d{4})-?(\d{2})-?(\d{2})[-_ ]?(\d{2})-?(\d{2})-?(\d{2})/.exec(file);
  if (match) {
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
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
  for (let n = 2; existsSync(join(archive, id, name)); n++) {
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
