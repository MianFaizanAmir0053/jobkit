import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { Split } from "./split";

/**
 * The split file (evals spec, "Splits"): `split.json` keeps, as a log in
 * the order they happened, every split `npm run eval:split` gave and every
 * test place it released, so the splits as they stand are read from the
 * whole history, never from a summary that could lose a case. Each write
 * adds to the log and changes nothing in it, and the file is written whole,
 * then copied whole to `split.json.bak`, so the copy holds every split too.
 * A file that is missing while its copy waits, cannot be read, breaks the
 * log's rules, or holds less than its copy stops whoever reads it: giving
 * the cases splits again could put a case labelled with suggestions in the
 * test set.
 */

export const SPLIT_FILE = "split.json";
export const SPLIT_COPY = "split.json.bak";

export type SplitEvent =
  { at: string; id: string; split: Split } | { at: string; id: string; release: true };

export interface SplitRecord {
  /** Every case's split as given; it never changes. */
  assigned: Record<string, Split>;
  /** Test cases whose places went to later cases, which never hold one again. */
  released: string[];
  /** The log, as the file keeps it. */
  log: SplitEvent[];
}

const eventSchema = z.union([
  z.strictObject({ at: z.string(), id: z.string(), split: z.enum(["test", "dev"]) }),
  z.strictObject({ at: z.string(), id: z.string(), release: z.literal(true) }),
]);

const fileSchema = z.strictObject({ version: z.literal(2), log: z.array(eventSchema) });

/** The log replayed, or the rule it breaks: a case given two splits, or a release of a case not in test. */
function replay(log: readonly SplitEvent[]): SplitRecord | string {
  const assigned: Record<string, Split> = {};
  const released: string[] = [];
  for (const event of log) {
    if ("split" in event) {
      if (Object.hasOwn(assigned, event.id)) return `it gives ${event.id} a split twice`;
      assigned[event.id] = event.split;
    } else {
      if (assigned[event.id] !== "test" || released.includes(event.id)) {
        return `it releases ${event.id}, which holds no test place`;
      }
      released.push(event.id);
    }
  }
  return { assigned, released, log: [...log] };
}

/** One file's log; a throw naming the file when it cannot be read or breaks the log's rules. */
function readLog(file: string): SplitEvent[] {
  let parsed;
  try {
    parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) {
    throw new Error(`${file} cannot be read.`);
  }
  const replayed = replay(parsed.data.log);
  if (typeof replayed === "string")
    throw new Error(`${file} does not hold a true log: ${replayed}.`);
  return parsed.data.log;
}

const sameEvent = (a: SplitEvent, b: SplitEvent) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The splits given so far, or null before the first. A copy one write
 * behind, as a write cut short between the two files leaves it, or a copy
 * gone, is read past: the file holds every split.
 */
export function readSplitRecord(archive: string): SplitRecord | null {
  const file = join(archive, SPLIT_FILE);
  const copy = join(archive, SPLIT_COPY);
  if (!existsSync(file)) {
    if (existsSync(copy)) {
      throw new Error(
        `${file} is missing, but ${SPLIT_COPY} holds every split given: copy it back to ${SPLIT_FILE}.`,
      );
    }
    return null;
  }
  let log: SplitEvent[];
  try {
    log = readLog(file);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${SPLIT_COPY} holds every split given: copy it over ${SPLIT_FILE} before labelling or running anything.`,
    );
  }
  if (existsSync(copy)) {
    let kept: SplitEvent[] | null;
    try {
      kept = readLog(copy);
    } catch {
      // A copy that cannot be read holds nothing the file lacks; the next write replaces it.
      kept = null;
    }
    if (kept && !kept.every((event, i) => log[i] !== undefined && sameEvent(event, log[i]))) {
      throw new Error(
        `${file} does not hold every split ${SPLIT_COPY} holds: one of them was changed by hand. Copy ${SPLIT_COPY} over ${SPLIT_FILE} if it is the later one.`,
      );
    }
  }
  return replay(log) as SplitRecord;
}

/** Writes a file whole: a crash leaves the old one, never half of the new. */
function writeWhole(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** Adds events to the log, checked against its rules first, and writes the file and its copy. */
export function appendSplitEvents(archive: string, events: readonly SplitEvent[]): SplitRecord {
  const log = [...(readSplitRecord(archive)?.log ?? []), ...events];
  const replayed = replay(log);
  if (typeof replayed === "string")
    throw new Error(`The split file cannot take this: ${replayed}.`);
  const text = `${JSON.stringify({ version: 2, log }, null, 2)}\n`;
  writeWhole(join(archive, SPLIT_FILE), text);
  writeWhole(join(archive, SPLIT_COPY), text);
  return replayed;
}

/** Every case the split file names: one gone from the archive was removed, and is not imported again. */
export function knownCaseIds(archive: string): Set<string> {
  return new Set(Object.keys(readSplitRecord(archive)?.assigned ?? {}));
}
