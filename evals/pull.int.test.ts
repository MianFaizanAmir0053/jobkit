import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { Storage } from "@/core/ports";
import type { PgliteDb } from "@/adapters/pglite";
import { confirmUploads, startJob } from "@/core/intake/jobs";
import type { ImageMeta } from "@/core/intake/limits";
import { createTestDb } from "@/server/db/testDb";

import { pullKeptJobs, releaseKeptJob } from "./pull";
import { appendSplitEvents } from "./splitFile";

/* Live cases: evals spec "Case sources", intake AC9's eval:pull clause. */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function png(shade: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 3,
        background: { r: shade, g: shade, b: shade },
      },
    })
      .png()
      .toBuffer(),
  );
}

/** A job with its screenshots uploaded and confirmed, as intake leaves it. */
async function jobWith(images: readonly Uint8Array[], pastedText = ""): Promise<string> {
  const metas: ImageMeta[] = images.map((bytes) => ({
    contentType: "image/png",
    bytes: bytes.length,
    width: 300,
    height: 200,
    sha256: sha256(bytes),
  }));
  const started = await startJob(
    { db, clock, storage },
    { images: metas, pastedText, clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  const { rows } = await db.query<{ storage_path: string }>(
    "select storage_path from {{schema}}.job_images where job_id = $1 order by position",
    [started.jobId],
  );
  for (const [i, row] of rows.entries())
    await storage.put(row.storage_path, images[i]!, "image/png");
  const confirmed = await confirmUploads({ db, clock, storage }, started.jobId);
  if (!confirmed.ok) throw new Error(confirmed.reason);
  return started.jobId;
}

async function keep(jobId: string): Promise<void> {
  await db.query("update {{schema}}.job_images set kept_for_eval = true where job_id = $1", [
    jobId,
  ]);
}

/** The second read's output, as address_read leaves it, with its crop stored. */
async function readWithCrop(jobId: string, crop: Uint8Array): Promise<void> {
  const cropPath = `jobs/${jobId}/crops/${sha256(crop)}.png`;
  await storage.put(cropPath, crop, "image/png");
  const lease = randomUUID();
  await db.query(
    "insert into {{schema}}.job_leases (id, job_id, claimed_at, expires_at) values ($1, $2, $3, $3)",
    [lease, jobId, clock.now()],
  );
  await db.query(
    `insert into {{schema}}.job_stage_runs
       (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash, started_at, ended_at)
     values ($1, $2, 'address_read', 0, 1, 'input', 'ok', $3, 'output', $4, $4)`,
    [
      jobId,
      lease,
      JSON.stringify({
        checked: true,
        kind: "email",
        contact: "jobs@example.com",
        second: { read: "jobs@example.com" },
        cropPath,
        markers: [],
      }),
      clock.now(),
    ],
  );
}

async function kept(jobId: string): Promise<boolean[]> {
  const { rows } = await db.query<{ kept_for_eval: boolean }>(
    "select kept_for_eval from {{schema}}.job_images where job_id = $1 order by position",
    [jobId],
  );
  return rows.map((row) => row.kept_for_eval);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.job_stage_runs; delete from {{schema}}.job_leases;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-pull-"));
  storage = createLocalStorage({ root: join(root, "storage"), origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pullKeptJobs", () => {
  it("copies each kept job's images into a case folder, then clears its keep flag", async () => {
    const images = [await png(10), await png(200)];
    const keptJob = await jobWith(images);
    const otherJob = await jobWith([await png(90)]);
    await keep(keptJob);
    const archive = join(root, "archive");

    const report = await pullKeptJobs({ db, storage }, archive);

    expect(report.failed).toEqual([]);
    expect(report.cases).toEqual([
      { id: `live-2026-10-06-${keptJob.slice(0, 8)}`, images: 2, existing: false },
    ]);
    const folder = join(archive, report.cases[0]!.id);
    expect(readdirSync(folder).sort()).toEqual(["post-1.png", "post-2.png", "source.json"]);
    expect(sha256(readFileSync(join(folder, "post-2.png")))).toBe(sha256(images[1]!));
    expect(JSON.parse(readFileSync(join(folder, "source.json"), "utf8"))).toEqual({
      jobId: keptJob,
      receivedAt: "2026-10-06T09:00:00.000Z",
    });
    expect(await kept(keptJob)).toEqual([false, false]);
    expect(await kept(otherJob)).toEqual([false]);

    expect(await pullKeptJobs({ db, storage }, archive)).toEqual({
      cases: [],
      failed: [],
      notes: [],
    });
  });

  it("keeps a job's flag, says why, and makes no case, when an image cannot be copied", async () => {
    const jobId = await jobWith([await png(10), await png(20)]);
    await keep(jobId);
    const { rows } = await db.query<{ storage_path: string }>(
      "select storage_path from {{schema}}.job_images where job_id = $1 order by position",
      [jobId],
    );
    await storage.remove([rows[1]!.storage_path]);
    const archive = join(root, "archive");

    const report = await pullKeptJobs({ db, storage }, archive);

    expect(report.cases).toEqual([]);
    expect(report.failed).toEqual([{ jobId, reason: "post image 2 is gone from storage" }]);
    expect(await kept(jobId)).toEqual([true, true]);
    expect(existsSync(join(archive, `live-2026-10-06-${jobId.slice(0, 8)}`))).toBe(false);

    // Released by hand, the job is left to the purge.
    expect(await releaseKeptJob(db, jobId)).toBe(2);
    expect(await kept(jobId)).toEqual([false, false]);
    expect(await pullKeptJobs({ db, storage }, archive)).toEqual({
      cases: [],
      failed: [],
      notes: [],
    });
  });

  it("clears only the flags of the images it copied, not one kept while it ran", async () => {
    const jobId = await jobWith([await png(10), await png(20)]);
    await db.query(
      "update {{schema}}.job_images set kept_for_eval = true where job_id = $1 and position = 0",
      [jobId],
    );
    // The owner keeps the second image while the first is being copied.
    const busy: Storage = {
      ...storage,
      get: async (path) => {
        await keep(jobId);
        return storage.get(path);
      },
    };

    const report = await pullKeptJobs({ db, storage: busy }, join(root, "archive"));

    expect(report.cases).toEqual([
      { id: `live-2026-10-06-${jobId.slice(0, 8)}`, images: 1, existing: false },
    ]);
    expect(await kept(jobId)).toEqual([false, true]);
  });

  it("says when it adds to a case already in the archive, and when a crop could not be copied", async () => {
    const jobId = await jobWith([await png(10), await png(20)]);
    await db.query(
      "update {{schema}}.job_images set kept_for_eval = true where job_id = $1 and position = 0",
      [jobId],
    );
    const archive = join(root, "archive");
    const first = await pullKeptJobs({ db, storage }, archive);
    expect(first.cases).toEqual([
      { id: `live-2026-10-06-${jobId.slice(0, 8)}`, images: 1, existing: false },
    ]);
    // Kept again later, with a crop whose bytes no longer match its name.
    await keep(jobId);
    await readWithCrop(jobId, await png(150));
    const { rows } = await db.query<{ output: { cropPath: string } }>(
      "select output from {{schema}}.job_stage_runs where job_id = $1 and stage = 'address_read'",
      [jobId],
    );
    await storage.put(rows[0]!.output.cropPath, await png(151), "image/png", { overwrite: true });

    const second = await pullKeptJobs({ db, storage }, archive);

    expect(second.cases).toEqual([
      { id: `live-2026-10-06-${jobId.slice(0, 8)}`, images: 2, existing: true },
    ]);
    expect(second.notes).toEqual([
      `live-2026-10-06-${jobId.slice(0, 8)}: its crop does not match its hash, so it was left out.`,
    ]);
  });

  it("says when a case's crop was replaced, since a crop answer judged the one before", async () => {
    const jobId = await jobWith([await png(10)]);
    await readWithCrop(jobId, await png(150));
    await keep(jobId);
    const archive = join(root, "archive");
    await pullKeptJobs({ db, storage }, archive);
    // Read again, with another crop, and kept again.
    await readWithCrop(jobId, await png(160));
    await keep(jobId);

    const second = await pullKeptJobs({ db, storage }, archive);

    expect(second.notes).toEqual([
      `live-2026-10-06-${jobId.slice(0, 8)}: its crop was replaced by the one the job now holds, so answer the crop question on its page again.`,
    ]);
  });

  it("never brings back a case set aside, nor one removed after it was given a split", async () => {
    const archive = join(root, "archive");
    const asideJob = await jobWith([await png(10)]);
    const removedJob = await jobWith([await png(20)]);
    await keep(asideJob);
    await keep(removedJob);
    const first = await pullKeptJobs({ db, storage }, archive);
    const [aside, removed] = first.cases.map((entry) => entry.id) as [string, string];
    mkdirSync(join(archive, "_dismissed"));
    renameSync(join(archive, aside), join(archive, "_dismissed", aside));
    appendSplitEvents(archive, [{ at: "2026-10-14T10:00:00.000Z", id: removed, split: "dev" }]);
    rmSync(join(archive, removed), { recursive: true });
    // Kept again on their job pages.
    await keep(asideJob);
    await keep(removedJob);

    const again = await pullKeptJobs({ db, storage }, archive);

    expect(again.cases).toEqual([]);
    expect(again.notes).toEqual([
      `${aside}: set aside as not an application, so it was not brought back.`,
      `${removed}: removed from the archive after it was given a split, so it was not brought back.`,
    ]);
    expect(existsSync(join(archive, aside))).toBe(false);
    expect(existsSync(join(archive, removed))).toBe(false);
    // Left to the purge, as a released job is.
    expect([...(await kept(asideJob)), ...(await kept(removedJob))]).toEqual([false, false]);
  });

  it("copies the stored crop of the contact and the pasted text with the images", async () => {
    const crop = await png(150);
    const jobId = await jobWith([await png(10)], "Apply at jobs@example.com");
    await readWithCrop(jobId, crop);
    await keep(jobId);
    const archive = join(root, "archive");

    const report = await pullKeptJobs({ db, storage }, archive);

    const folder = join(archive, report.cases[0]!.id);
    expect(readdirSync(folder).sort()).toEqual([
      "crop.png",
      "pasted.txt",
      "post-1.png",
      "source.json",
    ]);
    expect(sha256(readFileSync(join(folder, "crop.png")))).toBe(sha256(crop));
    expect(readFileSync(join(folder, "pasted.txt"), "utf8")).toBe("Apply at jobs@example.com");
  });
});
