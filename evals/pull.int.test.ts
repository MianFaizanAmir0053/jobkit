import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { confirmUploads, startJob } from "@/core/intake/jobs";
import type { ImageMeta } from "@/core/intake/limits";
import { createTestDb } from "@/server/db/testDb";

import { pullKeptJobs } from "./pull";

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
async function jobWith(images: readonly Uint8Array[]): Promise<string> {
  const metas: ImageMeta[] = images.map((bytes) => ({
    contentType: "image/png",
    bytes: bytes.length,
    width: 300,
    height: 200,
    sha256: sha256(bytes),
  }));
  const started = await startJob(
    { db, clock, storage },
    { images: metas, pastedText: "", clientElapsedMs: 0 },
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
    `delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
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
    expect(report.cases).toEqual([{ id: `live-2026-10-06-${keptJob.slice(0, 8)}`, images: 2 }]);
    const folder = join(archive, report.cases[0]!.id);
    expect(readdirSync(folder).sort()).toEqual(["post-1.png", "post-2.png", "source.json"]);
    expect(sha256(readFileSync(join(folder, "post-2.png")))).toBe(sha256(images[1]!));
    expect(JSON.parse(readFileSync(join(folder, "source.json"), "utf8"))).toEqual({
      jobId: keptJob,
      receivedAt: "2026-10-06T09:00:00.000Z",
    });
    expect(await kept(keptJob)).toEqual([false, false]);
    expect(await kept(otherJob)).toEqual([false]);

    expect(await pullKeptJobs({ db, storage }, archive)).toEqual({ cases: [], failed: [] });
  });

  it("keeps a job's flag, and says why, when an image cannot be copied", async () => {
    const jobId = await jobWith([await png(10)]);
    await keep(jobId);
    const { rows } = await db.query<{ storage_path: string }>(
      "select storage_path from {{schema}}.job_images where job_id = $1",
      [jobId],
    );
    await storage.remove([rows[0]!.storage_path]);

    const report = await pullKeptJobs({ db, storage }, join(root, "archive"));

    expect(report.cases).toEqual([]);
    expect(report.failed).toEqual([{ jobId, reason: "post image 1 is gone from storage" }]);
    expect(await kept(jobId)).toEqual([true]);
    expect(
      existsSync(join(root, "archive", `live-2026-10-06-${jobId.slice(0, 8)}`, "post-1.png")),
    ).toBe(false);
  });
});
