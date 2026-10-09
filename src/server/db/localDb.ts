import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { createPgliteDb, type PgliteDb } from "@/adapters/pglite";

/**
 * The local PGlite database under `.data/` serves one process at a time: a
 * second process that opens the folder works on its own copy, and whichever
 * closes last wins, so the other's writes are lost. The dev server and the
 * scripts' local mode therefore take a lock first, and a second program
 * stops with a message naming the first.
 */
const LOCK_FILE = "pglite.lock";

interface Holder {
  pid: number;
  holder: string;
}

/** Takes the lock on a local data folder for this process; returns what lets it go. */
export function lockLocalData(dataDir: string, holder: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, holder } satisfies Holder));
      closeSync(fd);
      const release = () => {
        if (heldBy(file)?.pid === process.pid) rmSync(file, { force: true });
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = heldBy(file);
    // The dev server builds its container again after a failed start.
    if (held?.pid === process.pid) return () => undefined;
    if (held && isRunning(held.pid)) {
      throw new Error(
        `The local database is in use by ${held.holder} (process ${held.pid}). Stop it, then run this again; if it is not running, delete ${file}.`,
      );
    }
    // Left behind by a process that ended without letting go.
    rmSync(file, { force: true });
  }
}

/** The local database, opened under the lock, which closing it lets go. */
export async function openLocalDb(
  dataDir: string,
  opts: { schema: string; holder: string },
): Promise<PgliteDb> {
  const release = lockLocalData(dataDir, opts.holder);
  try {
    const db = await createPgliteDb({ schema: opts.schema, dataDir: join(dataDir, "pglite") });
    return {
      ...db,
      close: async () => {
        try {
          await db.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

function heldBy(file: string): Holder | null {
  try {
    const held = JSON.parse(readFileSync(file, "utf8")) as Partial<Holder>;
    return typeof held.pid === "number" && typeof held.holder === "string"
      ? { pid: held.pid, holder: held.holder }
      : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
