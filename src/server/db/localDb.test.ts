import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lockLocalData, openLocalDb } from "./localDb";

let dir: string;
const lockFile = () => join(dir, "pglite.lock");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobkit-local-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A process ID no running process has. */
function endedProcess(): number {
  for (let pid = 4_000_001; ; pid += 2) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
}

describe("lockLocalData", () => {
  it("lets this process hold the local data and let go", () => {
    const release = lockLocalData(dir, "a test");

    expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toEqual({
      pid: process.pid,
      holder: "a test",
    });
    release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("lets go of its exit handler when released, so holds and releases do not pile up handlers", () => {
    const before = process.listenerCount("exit");

    for (let i = 0; i < 15; i++) lockLocalData(dir, "a test")();

    expect(process.listenerCount("exit")).toBe(before);
  });

  it("refuses a second hold in the same process, which would open the database twice", () => {
    const release = lockLocalData(dir, "a test");

    expect(() => lockLocalData(dir, "the same test, again")).toThrow(
      "The local database is already open in this process (a test).",
    );
    release();
  });

  it("refuses while another running process holds it, and names that process", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, holder: "the dev server" }));

    expect(() => lockLocalData(dir, "npm run profile:seed")).toThrow(
      `The local database is in use by the dev server (process ${process.ppid}). Stop it, then run this again; if it is not running, delete ${lockFile()}.`,
    );
  });

  it("takes over a lock left by a process that has ended", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: endedProcess(), holder: "the dev server" }));

    lockLocalData(dir, "a test")();

    expect(existsSync(lockFile())).toBe(false);
  });

  it("waits on a lock file it cannot read while it is new, and takes it over once it is old", () => {
    writeFileSync(lockFile(), "");

    expect(() => lockLocalData(dir, "a test")).toThrow(
      `The local database's lock is being taken by another program. Try again in a moment; if this keeps happening, delete ${lockFile()}.`,
    );
    const aMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), aMinuteAgo, aMinuteAgo);
    expect(() => lockLocalData(dir, "a test")()).not.toThrow();
  });
});

describe("openLocalDb", () => {
  it("opens the database under the lock, and lets go when it is closed", async () => {
    const db = await openLocalDb(dir, { schema: "jobkit", holder: "a test" });

    expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toMatchObject({ holder: "a test" });
    expect((await db.query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
    await db.close();
    expect(existsSync(lockFile())).toBe(false);
  });
});
