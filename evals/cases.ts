import { createHash } from "node:crypto";
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

import {
  bodiesOf,
  bodyText,
  DISMISSED,
  holdsStyleExample,
  IMPORT_FILE,
  importRecordOf,
  threadOf,
  wordsSha256,
} from "./import";
import { assignSplits, type Split, type SplitOutcome, TEST_SIZE } from "./split";
import {
  appendSplitEvents,
  readSplitRecord,
  SPLIT_COPY,
  SPLIT_FILE,
  type SplitEvent,
  type SplitRecord,
} from "./splitFile";

/**
 * The case archive (evals spec, "Case sources", "Labelling" and "Splits"):
 * one folder per case under `private/archive/`, a sent email's (`email.eml`)
 * or a kept job's (`source.json`, with its pasted text and the stored crop
 * of its contact when it had them), with the post's screenshots and, once
 * labelled, `labels.json`. Screenshots not yet matched to a case wait in
 * `_screenshots/`; cases the owner set aside as not applications wait in
 * `_dismissed/`. A case gets its split from `npm run eval:split`, never from
 * viewing the page, and keeps it in the split file's log (splitFile.ts).
 * Pre-labels (`prelabels.json`) are shown for a dev case alone: a test
 * case's stay hidden even after its labels are saved, so the blind labels
 * are never shaped by a model (amendment A10). An application is blind
 * only while none of its cases, those set aside included, is a kept live
 * job, whose owner has seen jobkit's reading of it, was labelled with
 * pre-labels shown, or is in dev; a test case of an application that is
 * not blind is never scored. A sent email is left out when its application
 * holds one of the profile's style examples, however late the example was
 * chosen, or when it was sent from the day jobkit began drafting (A10).
 */

/** A case folder's name: a sent email's ("2026-03-16-8282e9a1") or a kept job's ("live-…"). */
export const CASE_ID = /^(?:live-)?(?:\d{4}-\d{2}-\d{2}|undated)-[0-9a-f]{8}$/;

/** A case, or a screenshot in the pool, that is not there: the labelling routes answer 404. */
export class NoCase extends Error {}

/** The folder of screenshots not yet matched to a case. */
export const POOL = "_screenshots";

/** The archive's own files at its top; its own folders start with "_" (the pool, the set-aside, eval:pull's). */
const OWN_FILES = new Set([SPLIT_FILE, SPLIT_COPY, IMPORT_FILE]);
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

/** Routes that always have an address or number, which the labels must give. */
const ROUTES_WITH_CONTACT: ReadonlySet<string> = new Set(["email", "whatsapp"]);

export const labelsSchema = z
  .strictObject({
    company: z.string().trim().max(200),
    role: z.string().trim().max(200),
    route: z.enum(ROUTE_KINDS),
    /** The exact address, number or link; empty only for a route that has none. */
    contact: z.string().trim().max(2000),
    eligibility: z.enum(["eligible", "unclear", "likely_ineligible"]),
    must: z.array(z.string().trim().min(1).max(300)).max(40),
    /** Said when the post names no must-have, so an empty list is never merely unfilled. */
    noMust: z.boolean().optional(),
    /** Whether the crop shows the whole contact; null with no crop to judge. */
    cropShowsContact: z.boolean().nullable(),
    /**
     * For sent mail, whether the post was ever run through jobkit, as on the
     * laptop from the phone's screenshots: then its labels cannot be blind.
     * Null for a kept job, whose post jobkit read.
     */
    seenInJobkit: z.boolean().nullable(),
  })
  .superRefine((labels, ctx) => {
    if (ROUTES_WITH_CONTACT.has(labels.route) && labels.contact === "") {
      ctx.addIssue({
        code: "custom",
        path: ["contact"],
        message: "An email or WhatsApp route has an address or number.",
      });
    }
    if (labels.must.length === 0 && labels.noMust !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["must"],
        message: "List the must-haves, or say the post names none.",
      });
    }
    if (labels.must.length > 0 && labels.noMust === true) {
      ctx.addIssue({
        code: "custom",
        path: ["noMust"],
        message: "The post names must-haves, or none: not both.",
      });
    }
  });

export type Labels = z.infer<typeof labelsSchema>;

/**
 * What the case page showed of a case, sent back with its labels, so they
 * record exactly that: the split it showed, and the SHA-256 of the
 * pre-labels and of the crop it showed, or null for none.
 */
export const shownSchema = z.strictObject({
  split: z.enum(["test", "dev"]).nullable(),
  prelabelsSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  cropSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export type Shown = z.infer<typeof shownSchema>;

/** The case changed since its page showed it: the owner must look at it again. */
export class CaseChanged extends Error {}

/** Labels that do not fit their case, such as a crop answer where no crop is shown: which fields. */
export class LabelsRefused extends Error {
  constructor(readonly fields: string[]) {
    super(`These labels do not fit the case: ${fields.join(", ")}.`);
  }
}

/** What saving recorded with a case's labels. */
export interface LabelledUnder {
  labelledAt: string | null;
  split: Split | null;
  prelabelsShown: boolean | null;
  /** The crop a crop label judged; null without one. */
  cropSha256: string | null;
}

/** The profile's style examples, as text (styleExamplesOf), which leave a sent email out. */
export interface CaseOptions {
  styleExamples: readonly string[];
}

/**
 * Why a case is never scored: its application holds a style example; jobkit
 * may have drafted it; its test place went to a later case once it was
 * away or left out ("released"); or it holds a test place while its
 * application cannot be blind ("not_blind").
 */
export type LeftOut = "style_example" | "after_jobkit" | "released" | "not_blind";

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
  /** Why it is never scored (A10), or null. */
  leftOut: LeftOut | null;
  /** Other cases that seem the same application: a resend, or a reply in its thread. */
  sameAs: string[];
  /**
   * Ready, but held without a split: its application is in a full test set,
   * so it waits until the extra cases are set aside.
   */
  held: boolean;
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
  /** What saving recorded with the labels; null before they are saved. */
  labelledUnder: LabelledUnder | null;
  /**
   * Pre-labels to start from: a dev case's alone, once every test case is
   * labelled, without a crop or seen-in-jobkit answer, which only the owner
   * gives.
   */
  prelabels: Labels | null;
  /** What the page shows, which saving checks again and records. */
  shown: Shown;
  /** Whether the saved crop answer judged another crop than the one shown now. */
  cropChanged: boolean;
}

export interface Archive {
  cases: CaseSummary[];
  /** What at the archive's top is not a case, such as a folder named by hand. */
  stray: string[];
}

export interface SplitReport {
  /** Cases given a split by this run. */
  added: number;
  /** The cases this run put in test, and how many it put in dev. */
  test: string[];
  dev: number;
  /** Cases with no split, not left out, and not ready: no screenshots yet, or a file that cannot be read. */
  waiting: number;
  /** Cases left out (A10). */
  leftOut: number;
  /** Ready cases left without a split: their application is in a full test set. */
  held: string[];
  /** Test cases away or left out whose places this run gave to new cases: never scored again. */
  released: string[];
}

function isImage(file: string): boolean {
  return Object.hasOwn(IMAGE_TYPES, extname(file).toLowerCase());
}

/** A file name inside one folder: no separators, no "." or "..". */
function isPlainName(file: string): boolean {
  return /^[^\\/]+$/.test(file) && file !== "." && file !== "..";
}

function caseIds(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && CASE_ID.test(entry.name))
    .map((entry) => entry.name);
}

/** Writes a file whole: a crash leaves the old one, never half of the new. */
function writeWhole(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A JSON file checked against its schema; null when there is none, a throw naming it when it does not fit. */
function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`${file} is not JSON.`);
  }
  if (!parsed.success) throw new Error(`${file} does not hold what it should.`);
  return parsed.data;
}

const sourceSchema = z.object({ jobId: z.string(), receivedAt: z.string() });

/**
 * A labels file as saved, read without its refinements, or what saving
 * adds: z.object drops unknown keys. One saved before the seen-in-jobkit
 * question reads as unanswered.
 */
const savedLabelsSchema = z
  .object({ ...labelsSchema.shape, seenInJobkit: z.boolean().nullable().optional() })
  .transform((labels): Labels => ({ ...labels, seenInJobkit: labels.seenInJobkit ?? null }));

/** What saving adds to a case's labels: when, under which split, and what the owner was shown. */
const labelledUnderSchema = z.object({
  labelledAt: z.string().optional(),
  split: z.enum(["test", "dev"]).nullable().optional(),
  prelabelsShown: z.boolean().optional(),
  prelabelsSha256: z.string().nullable().optional(),
  cropSha256: z.string().nullable().optional(),
});

/** What a sent email gives the archive, kept by the file's time and size so the archive is parsed once. */
interface MailRead {
  email: NonNullable<CaseDetail["email"]>;
  /** Its plain-text and HTML bodies, which a style example is looked for in. */
  bodies: string[];
  messageId: string | null;
  answers: string[];
  words: string;
}

const mailCache = new Map<string, { stamp: string; mail: MailRead }>();

async function readMail(file: string): Promise<MailRead> {
  const { mtimeMs, size } = statSync(file);
  const stamp = `${mtimeMs}:${size}`;
  const cached = mailCache.get(file);
  if (cached?.stamp === stamp) return cached.mail;
  const parsed = await PostalMime.parse(readFileSync(file));
  const sent = new Date(parsed.date ?? "");
  const name = (address: { name: string; address?: string }) =>
    address.address ? `${address.name} <${address.address}>`.trim() : address.name;
  const mail: MailRead = {
    email: {
      from: parsed.from ? name(parsed.from) : "",
      to: (parsed.to ?? []).map((address) => address.address ?? address.name).join(", "),
      subject: parsed.subject ?? "",
      date: Number.isNaN(sent.getTime()) ? null : sent.toISOString(),
      text: bodyText(parsed),
    },
    bodies: bodiesOf(parsed),
    ...threadOf(parsed),
  };
  mailCache.set(file, { stamp, mail });
  return mail;
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
  /** The SHA-256 of the crop as it is now; null without one. */
  cropSha256: string | null;
  pastedText: string | null;
  labels: Labels | null;
  /** What saving recorded with the labels. */
  labelledUnder: z.infer<typeof labelledUnderSchema> | null;
  prelabels: Labels | null;
  /** The SHA-256 of the pre-labels file, when it can be read. */
  prelabelsSha256: string | null;
  leftOut: LeftOut | null;
  problem: string | null;
}

async function readFolder(
  archive: string,
  id: string,
  options: CaseOptions,
  jobkitFrom: Date | null,
): Promise<FolderRead> {
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
    cropSha256: images.includes(CROP_FILE) ? sha256(readFileSync(join(folder, CROP_FILE))) : null,
    pastedText: null,
    labels: null,
    labelledUnder: null,
    prelabels: null,
    prelabelsSha256: null,
    leftOut: null,
    problem: null,
  };
  try {
    // Pre-labels a model wrote may not fit: they are only suggestions, so they are passed over.
    read.prelabels = readJson(join(folder, "prelabels.json"), savedLabelsSchema);
    if (read.prelabels) read.prelabelsSha256 = sha256(readFileSync(join(folder, "prelabels.json")));
  } catch {
    read.prelabels = null;
  }
  try {
    if (read.source === "mail") {
      const file = join(folder, "email.eml");
      if (!existsSync(file)) throw new Error("There is no email.eml in its folder.");
      let mail: MailRead;
      try {
        mail = await readMail(file);
      } catch (error) {
        throw new Error(
          `Its email.eml cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      read.email = mail.email;
      read.thread = { messageId: mail.messageId, answers: mail.answers, words: mail.words };
      if (holdsStyleExample(mail.bodies, options.styleExamples)) {
        read.leftOut = "style_example";
      } else if (
        jobkitFrom &&
        // Undated mail cannot show it came before jobkit began drafting.
        (mail.email.date === null || Date.parse(mail.email.date) >= jobkitFrom.getTime())
      ) {
        read.leftOut = "after_jobkit";
      }
    } else {
      const source = readJson(join(folder, "source.json"), sourceSchema);
      if (!source) {
        throw new Error("There is no source.json in its folder: pull the job again.");
      }
      read.receivedAt = source.receivedAt;
      const pasted = join(folder, PASTED_FILE);
      read.pastedText = existsSync(pasted) ? readFileSync(pasted, "utf8") : null;
    }
    const labelsFile = join(folder, "labels.json");
    read.labels = readJson(labelsFile, savedLabelsSchema);
    read.labelledUnder = readJson(labelsFile, labelledUnderSchema);
  } catch (error) {
    read.problem = error instanceof Error ? error.message : String(error);
  }
  return read;
}

/** Ready to label: readable, not left out, with the post's screenshots or a kept job's pasted text. */
function isReady(read: FolderRead): boolean {
  const post =
    read.screenshotFiles.length > 0 ||
    (read.source === "live" && (read.pastedText ?? "").trim() !== "");
  return read.problem === null && read.leftOut === null && post;
}

/**
 * Whether a case's labels can be blind: never a kept live job's, whose
 * owner has seen jobkit's reading of it, nor one labelled with pre-labels
 * shown, nor one whose post the owner ran through jobkit, nor one whose
 * labels do not record either.
 */
function canBeBlind(read: FolderRead): boolean {
  if (read.source !== "mail") return false;
  if (read.labels === null) return true;
  return read.labelledUnder?.prelabelsShown === false && read.labels.seenInJobkit === false;
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

/** The archive as read: its cases, those set aside, their applications and the splits given. */
interface ArchiveState {
  /** The cases at the archive's top, each with why it is left out, if it is. */
  reads: FolderRead[];
  /** Each case's application, for the cases set aside too, named by its first case ID. */
  applications: Map<string, string>;
  /** The splits given and the places released; empty before the first split. */
  record: SplitRecord;
  /** The applications that cannot be blind: one of their cases is a live job's, was labelled with pre-labels shown, or is in dev. */
  notBlind: ReadonlySet<string>;
}

/**
 * Every case's folder read, those set aside included, since they are still
 * cases of their applications, and the applications they make; and the
 * split file, checked against what the labels recorded. An application one
 * of whose emails holds a style example is left out whole: a resend or a
 * reply is the post the drafter was shown. A test case released, or of an
 * application that cannot be blind, is left out too. Stops while mail
 * cases are in the archive but the day jobkit began drafting is not, when
 * the split file is missing yet cases were labelled under a split, when a
 * case's labels name a split the file does not give it, and when more than
 * ten cases hold test places.
 */
async function stateOf(archive: string, options: CaseOptions): Promise<ArchiveState> {
  const imported = importRecordOf(archive);
  const jobkitFrom = imported?.jobkitFrom ?? null;
  const reads: FolderRead[] = [];
  for (const id of caseIds(archive)) {
    reads.push(await readFolder(archive, id, options, jobkitFrom));
  }
  const aside: FolderRead[] = [];
  for (const id of caseIds(join(archive, DISMISSED))) {
    if (!reads.some((read) => read.id === id)) {
      aside.push(await readFolder(join(archive, DISMISSED), id, options, jobkitFrom));
    }
  }
  if (jobkitFrom === null && [...reads, ...aside].some((read) => read.source === "mail")) {
    throw new Error(
      `The archive holds sent mail but not ${IMPORT_FILE}, which keeps the day jobkit began drafting: restore it, or run npm run eval:import again with --jobkit-from <YYYY-MM-DD>.`,
    );
  }
  const all = [...reads, ...aside];
  // A reply to, or a resend of, mail the import left out for a style example is that application.
  const leftOutIds = new Set(
    (imported?.leftOut ?? []).flatMap((mail) => [
      ...(mail.messageId ? [mail.messageId] : []),
      ...mail.answers,
    ]),
  );
  const leftOutWords = new Set((imported?.leftOut ?? []).map((mail) => mail.wordsSha256));
  for (const read of all) {
    const thread = read.thread;
    if (!thread || read.leftOut !== null) continue;
    if (
      (thread.messageId && leftOutIds.has(thread.messageId)) ||
      thread.answers.some((id) => leftOutIds.has(id)) ||
      leftOutWords.has(wordsSha256(thread.words))
    ) {
      read.leftOut = "style_example";
    }
  }
  const applications = applicationsOf(all);
  const shown = new Set(
    all.filter((read) => read.leftOut === "style_example").map((read) => applications.get(read.id)),
  );
  for (const read of reads) {
    if (shown.has(applications.get(read.id))) read.leftOut = "style_example";
  }

  const saved = readSplitRecord(archive);
  if (!saved && all.some((read) => read.labelledUnder?.split)) {
    throw new Error(
      `${join(archive, SPLIT_FILE)} is missing, yet cases were labelled under a split: restore it before giving or reading splits.`,
    );
  }
  const record = saved ?? { assigned: {}, released: [], log: [] };
  for (const read of all) {
    const under = read.labelledUnder?.split;
    if (under && record.assigned[read.id] !== under) {
      throw new Error(
        `${read.id}'s labels.json was saved under ${under}, but ${SPLIT_FILE} gives it ${record.assigned[read.id] ?? "no split"}: restore the split file the labels were saved under.`,
      );
    }
  }

  // An application is blind while none of its cases could show the owner jobkit's reading of it.
  const notBlind = new Set(
    all
      .filter((read) => !canBeBlind(read) || record.assigned[read.id] === "dev")
      .map((read) => applications.get(read.id) ?? read.id),
  );
  const released = new Set(record.released);
  for (const read of reads) {
    if (read.leftOut !== null || record.assigned[read.id] !== "test") continue;
    if (released.has(read.id)) read.leftOut = "released";
    else if (notBlind.has(applications.get(read.id) ?? read.id)) read.leftOut = "not_blind";
  }
  const testCases = reads.filter(
    (read) => read.leftOut === null && record.assigned[read.id] === "test",
  ).length;
  if (testCases > TEST_SIZE) {
    throw new Error(
      `${testCases} cases hold test places, more than ${TEST_SIZE}: ${SPLIT_FILE} was changed by hand, or a case set aside was moved back. Restore the split file, or set the extra cases aside again.`,
    );
  }
  return { reads, applications, record, notBlind };
}

/** Whether a case's application can be blind: none of its cases, those set aside included, could show jobkit's reading. */
function blindOf(state: ArchiveState): (id: string) => boolean {
  return (id) => !state.notBlind.has(state.applications.get(id) ?? id);
}

/**
 * The draw eval:split would make now: the cases ready to label get splits,
 * and those of an application in a full test set are held. Viewing the
 * page computes it only to name the held cases; only fixSplit keeps it.
 */
function planOf(state: ArchiveState): SplitOutcome {
  const present = state.reads.filter((read) => read.leftOut === null);
  const blind = blindOf(state);
  return assignSplits({
    ready: present.filter(isReady).map((read) => read.id),
    present: present.map((read) => read.id),
    assigned: state.record.assigned,
    released: state.record.released,
    groupOf: (id) => state.applications.get(id) ?? id,
    blind,
  });
}

function detailOf(read: FolderRead, state: ArchiveState, held: ReadonlySet<string>): CaseDetail {
  const { applications, record } = state;
  const split = record.assigned[read.id] ?? null;
  const application = applications.get(read.id);
  // A dev case's pre-labels wait until every test case is labelled, so none shaped a blind label.
  const testLabelled = state.reads
    .filter((each) => each.leftOut === null && record.assigned[each.id] === "test")
    .every((each) => each.labels !== null);
  const prelabels =
    split === "dev" && testLabelled && read.prelabels
      ? { ...read.prelabels, cropShowsContact: null, seenInJobkit: null }
      : null;
  const shown: Shown = {
    split,
    prelabelsSha256: prelabels ? read.prelabelsSha256 : null,
    cropSha256: split === "dev" ? read.cropSha256 : null,
  };
  const under = read.labelledUnder;
  return {
    id: read.id,
    split,
    source: read.source,
    date: read.email?.date ?? read.receivedAt,
    title: read.email?.subject || (read.source === "live" ? "A job kept from the app" : read.id),
    screenshots: read.screenshotFiles.length,
    labelled: read.labels !== null,
    leftOut: read.leftOut,
    // Only cases still in the archive: one set aside needs nothing more from the owner.
    sameAs: state.reads
      .filter((other) => applications.get(other.id) === application && other.id !== read.id)
      .map((other) => other.id)
      .sort(),
    held: held.has(read.id),
    problem: read.problem,
    email: read.email,
    screenshotFiles: read.screenshotFiles,
    cropFile: read.cropFile,
    pastedText: read.pastedText,
    labels: read.labels,
    labelledUnder:
      read.labels && under
        ? {
            labelledAt: under.labelledAt ?? null,
            split: under.split ?? null,
            prelabelsShown: under.prelabelsShown ?? null,
            cropSha256: under.cropSha256 ?? null,
          }
        : null,
    prelabels,
    shown,
    cropChanged:
      read.labels !== null &&
      read.labels.cropShowsContact !== null &&
      (under?.cropSha256 ?? null) !== shown.cropSha256,
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
  const state = await stateOf(archive, options);
  const held = new Set(planOf(state).held);
  const cases = state.reads.map((read): CaseSummary => {
    const detail = detailOf(read, state, held);
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
      held: detail.held,
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
  const state = await stateOf(archive, options);
  const read = state.reads.find((each) => each.id === id);
  return read ? detailOf(read, state, new Set(planOf(state).held)) : null;
}

/**
 * Gives a split to every case ready to label that has none (`npm run
 * eval:split`), which the owner runs once the cases they mean to keep have
 * their screenshots, and again for cases that arrive later. While test has
 * a free place and cases still wait, it refuses unless told to go on
 * (`partial`), so the test set is a draw from all the cases, never the
 * first ones matched; a case that could never take a test place, a kept
 * live job's or one of an application that cannot be blind, holds nothing
 * up. Each split given and each place released is added to the split
 * file's log.
 */
export async function fixSplit(
  archive: string,
  options: CaseOptions,
  opts: { partial?: boolean; now?: Date } = {},
): Promise<SplitReport> {
  const state = await stateOf(archive, options);
  const { reads, record } = state;
  const present = reads.filter((read) => read.leftOut === null);
  const waiting = present.filter(
    (read) => !isReady(read) && !Object.hasOwn(record.assigned, read.id),
  );
  const testPlaces =
    TEST_SIZE - present.filter((read) => record.assigned[read.id] === "test").length;
  const blind = blindOf(state);
  const contenders = waiting.filter((read) => blind(read.id));
  if (testPlaces > 0 && contenders.length > 0 && !opts.partial) {
    const many = contenders.length === 1 ? "1 case is" : `${contenders.length} cases are`;
    throw new Error(
      `${many} still waiting for screenshots, or has a file that cannot be read, while test has ${testPlaces} free places: add the screenshots, set aside what is not an application, or run npm run eval:split -- --partial to fill test without them.`,
    );
  }
  const { splits, held, released } = planOf(state);
  const added = Object.keys(splits)
    .filter((id) => !Object.hasOwn(record.assigned, id))
    .sort();
  const at = (opts.now ?? new Date()).toISOString();
  const events: SplitEvent[] = [
    ...added.map((id) => ({ at, id, split: splits[id]! })),
    ...released.map((id) => ({ at, id, release: true as const })),
  ];
  if (events.length > 0) appendSplitEvents(archive, events);
  return {
    added: added.length,
    test: added.filter((id) => splits[id] === "test"),
    dev: added.filter((id) => splits[id] === "dev").length,
    waiting: waiting.length,
    leftOut: reads.filter((read) => read.leftOut !== null).length,
    held,
    released,
  };
}

/**
 * Saves a case's labels, checked against the schema and against the case:
 * a crop answer only where the page shows a crop, and needed there; the
 * seen-in-jobkit answer for sent mail alone. The page sends what it showed,
 * and a case that changed since (another split, other pre-labels, another
 * crop) is refused, so the labels record exactly what the owner saw: when
 * they were saved, the split, whether and which pre-labels were shown, and
 * the crop a crop answer judged. The file is written whole.
 */
export async function saveLabels(
  archive: string,
  id: string,
  save: { labels: Labels; shown: Shown; at: Date },
  options: CaseOptions,
): Promise<void> {
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) throw new NoCase(`No case ${id}`);
  const checked = labelsSchema.parse(save.labels);
  const current = await readCase(archive, id, options);
  if (!current) throw new NoCase(`No case ${id}`);
  const { shown } = save;
  if (
    current.shown.split !== shown.split ||
    current.shown.prelabelsSha256 !== shown.prelabelsSha256 ||
    current.shown.cropSha256 !== shown.cropSha256
  ) {
    throw new CaseChanged(`Case ${id} changed since its page showed it.`);
  }
  const fields: string[] = [];
  if ((checked.cropShowsContact !== null) !== (shown.cropSha256 !== null)) {
    fields.push("cropShowsContact");
  }
  if ((checked.seenInJobkit !== null) !== (current.source === "mail")) fields.push("seenInJobkit");
  if (fields.length > 0) throw new LabelsRefused(fields);
  writeWhole(
    join(archive, id, "labels.json"),
    `${JSON.stringify(
      {
        ...checked,
        labelledAt: save.at.toISOString(),
        split: shown.split,
        prelabelsShown: shown.prelabelsSha256 !== null,
        prelabelsSha256: shown.prelabelsSha256,
        cropSha256: checked.cropShowsContact !== null ? shown.cropSha256 : null,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Sets aside a case that is not an application, moving its folder to
 * `_dismissed/`: out of the list and of its split's count, and never
 * brought back by an import. It stays a case of its application, so an
 * application one of whose cases was in dev never enters test. Setting
 * aside is for good: a test case's place goes to a later case, and the
 * case is never scored again, even if its folder is moved back.
 */
export function dismissCase(archive: string, id: string): void {
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) throw new NoCase(`No case ${id}`);
  const aside = join(archive, DISMISSED, id);
  if (existsSync(aside)) throw new Error(`A case ${id} is already set aside`);
  mkdirSync(join(archive, DISMISSED), { recursive: true });
  renameSync(join(archive, id), aside);
}

/**
 * When a screenshot was taken: from a phone's file name, which gives the
 * phone's local time and so the laptop's, when it names a real time; else
 * the file's time.
 */
function takenAt(folder: string, file: string): Date {
  const match = /(\d{4})-?(\d{2})-?(\d{2})[-_ ]?(\d{2})-?(\d{2})-?(\d{2})/.exec(file);
  if (match) {
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const parsed = new Date(year, month - 1, day, hour, minute, second);
    const real =
      year >= 2000 &&
      year <= 2100 &&
      parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day &&
      parsed.getHours() === hour &&
      parsed.getMinutes() === minute &&
      parsed.getSeconds() === second;
    if (real) return parsed;
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
  if (!CASE_ID.test(id) || !existsSync(join(archive, id))) throw new NoCase(`No case ${id}`);
  if (!isPlainName(file) || !isImage(file)) throw new NoCase(`Not a screenshot: ${file}`);
  const from = join(archive, POOL, file);
  if (!existsSync(from)) throw new NoCase(`No screenshot ${file} in the pool`);
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
