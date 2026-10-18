import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import { confirmUploads, startJob } from "./jobs";
import { keepForEvaluation, keptForEvaluation } from "./keepForEval";
import type { ImageMeta } from "./limits";

/* "Keep for evaluation" on the job page: evals spec, "Case sources", live cases. */

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

/** A job with its screenshots uploaded and confirmed, as intake leaves it; or of pasted text alone. */
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
  if (images.length === 0) return started.jobId;
  const { rows } = await db.query<{ storage_path: string }>(
    "select storage_path from {{schema}}.job_images where job_id = $1 order by position",
    [started.jobId],
  );
  for (const [i, row] of rows.entries()) {
    await storage.put(row.storage_path, images[i]!, "image/png");
  }
  const confirmed = await confirmUploads({ db, clock, storage }, started.jobId);
  if (!confirmed.ok) throw new Error(confirmed.reason);
  return started.jobId;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-keep-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("keepForEvaluation", () => {
  it("keeps every screenshot of the job for eval:pull, and lets them go again", async () => {
    const id = await jobWith([await png(10), await png(200)]);
    expect(await keptForEvaluation(db, id)).toBe(false);

    expect(await keepForEvaluation(db, id, true)).toEqual({ ok: true, kept: true });

    expect(await keptForEvaluation(db, id)).toBe(true);
    const { rows } = await db.query<{ kept_for_eval: boolean }>(
      "select kept_for_eval from {{schema}}.job_images where job_id = $1",
      [id],
    );
    expect(rows.map((row) => row.kept_for_eval)).toEqual([true, true]);
    expect(await keepForEvaluation(db, id, false)).toEqual({ ok: true, kept: false });
    expect(await keptForEvaluation(db, id)).toBe(false);
  });

  it("cannot keep a job of pasted text alone, whose keep flag would have no screenshot to live on", async () => {
    const id = await jobWith([], "Northwind Analytics is hiring. Apply to jobs@example.com.");

    expect(await keptForEvaluation(db, id)).toBeNull();
    expect(await keepForEvaluation(db, id, true)).toEqual({ ok: false, reason: "no-images" });
    expect(await keepForEvaluation(db, "00000000-0000-4000-8000-000000000000", true)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});
