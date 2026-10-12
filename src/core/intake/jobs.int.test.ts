import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { loadJob } from "@/core/platform/jobs";
import { createTestDb } from "@/server/db/testDb";

import { confirmUploads, type ImageMeta, LIMITS, startJob } from "./jobs";

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
const deps = () => ({ db, clock, storage });

const hash = (n: number) => n.toString(16).padStart(64, "0");
const image = (n: number, overrides: Partial<ImageMeta> = {}): ImageMeta => ({
  contentType: "image/webp",
  bytes: 1_000 + n,
  width: 1080,
  height: 2400,
  sha256: hash(n),
  ...overrides,
});

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
  root = mkdtempSync(join(tmpdir(), "jobkit-intake-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A real WebP and the metadata the phone would declare for it. */
async function webp(width: number, height: number, shade: number) {
  const bytes = new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: shade, g: shade, b: shade } },
    })
      .webp()
      .toBuffer(),
  );
  const meta: ImageMeta = {
    contentType: "image/webp",
    bytes: bytes.length,
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { bytes, meta };
}

async function images(jobId: string) {
  const { rows } = await db.query<{
    id: string;
    position: number;
    purpose: string;
    storage_path: string;
    bytes: number;
    tile_count: number;
    purge_after: Date;
  }>(
    `select id, position, purpose, storage_path, bytes, tile_count, purge_after
       from {{schema}}.job_images where job_id = $1 order by position`,
    [jobId],
  );
  return rows;
}

describe("startJob", () => {
  it("creates one job with its images in order, each under the job's path with its own upload URL", async () => {
    const started = await startJob(deps(), {
      images: [image(1), image(2), image(3, { contentType: "image/jpeg" })],
      pastedText: "",
      clientElapsedMs: 2_500,
    });

    if (!started.ok) throw new Error(started.message);
    expect(started.queued).toBe(false);
    expect(await loadJob(db, started.jobId)).toMatchObject({
      state: "uploading",
      clientElapsedMs: 2_500,
    });
    const stored = await images(started.jobId);
    expect(stored.map((row) => [row.position, row.purpose, row.bytes, row.tile_count])).toEqual([
      [0, "post", 1_001, 1],
      [1, "post", 1_002, 1],
      [2, "post", 1_003, 1],
    ]);
    expect(stored[0]!.storage_path).toBe(`jobs/${started.jobId}/${stored[0]!.id}.webp`);
    expect(stored[2]!.storage_path).toBe(`jobs/${started.jobId}/${stored[2]!.id}.jpg`);
    expect(stored[0]!.purge_after).toEqual(new Date(clock.now().getTime() + 30 * 24 * 60 * 60_000));
    // Each image's SHA-256 is recorded as declared (intake AC2).
    const { rows: hashes } = await db.query<{ sha256: string }>(
      "select sha256 from {{schema}}.job_images where job_id = $1 order by position",
      [started.jobId],
    );
    expect(hashes.map((row) => row.sha256)).toEqual([hash(1), hash(2), hash(3)]);
    expect(started.uploads.map((upload) => upload.imageId)).toEqual(stored.map((row) => row.id));
    expect(new Set(started.uploads.map((upload) => upload.url)).size).toBe(3);
  });

  it("drops an image whose hash repeats one before it", async () => {
    const started = await startJob(deps(), {
      images: [image(1), image(2), image(1)],
      pastedText: "",
      clientElapsedMs: 0,
    });

    if (!started.ok) throw new Error(started.message);
    expect((await images(started.jobId)).map((row) => row.bytes)).toEqual([1_001, 1_002]);
  });

  it("counts tall screenshots' tiles", async () => {
    const started = await startJob(deps(), {
      images: [image(1, { height: 6_000 })],
      pastedText: "",
      clientElapsedMs: 0,
    });

    if (!started.ok) throw new Error(started.message);
    expect((await images(started.jobId))[0]!.tile_count).toBe(3);
  });

  it("counts the job's start back from when its request arrived (intake AC10)", async () => {
    const arrived = new Date(clock.now().getTime() - 4_000);

    const started = await startJob(
      deps(),
      { images: [], pastedText: "a post", clientElapsedMs: 2_500 },
      arrived,
    );

    if (!started.ok) throw new Error(started.message);
    expect(await loadJob(db, started.jobId)).toMatchObject({
      receivedAt: arrived,
      clientElapsedMs: 2_500,
    });
  });

  it("refuses a clock that says the page held the job for more than a day", async () => {
    expect(
      await startJob(deps(), {
        images: [],
        pastedText: "a post",
        clientElapsedMs: 24 * 60 * 60 * 1000 + 1,
      }),
    ).toEqual({
      ok: false,
      message: "The page's clock went wrong. Reload the page and press Start again.",
    });
  });

  it("drops NUL characters from the pasted text, which Postgres cannot store", async () => {
    const nul = String.fromCharCode(0);

    const started = await startJob(deps(), {
      images: [],
      pastedText: `We're hiring${nul}. Apply at jobs@example.com`,
      clientElapsedMs: 0,
    });

    if (!started.ok) throw new Error(started.message);
    const { rows } = await db.query<{ pasted_text: string }>(
      "select pasted_text from {{schema}}.jobs where id = $1",
      [started.jobId],
    );
    expect(rows).toEqual([{ pasted_text: "We're hiring. Apply at jobs@example.com" }]);
  });

  it("starts a paste-only job queued, keeping its text, with nothing to upload", async () => {
    const started = await startJob(deps(), {
      images: [],
      pastedText: "We're hiring a React developer. Apply at jobs@example.com",
      clientElapsedMs: 0,
    });

    if (!started.ok) throw new Error(started.message);
    expect(started).toMatchObject({ queued: true, uploads: [] });
    const { rows } = await db.query<{ state: string; pasted_text: string }>(
      "select state, pasted_text from {{schema}}.jobs where id = $1",
      [started.jobId],
    );
    expect(rows).toEqual([
      { state: "queued", pasted_text: "We're hiring a React developer. Apply at jobs@example.com" },
    ]);
  });

  it("refuses what breaks intake's limits, creating no job", async () => {
    const refusals = [
      { images: Array.from({ length: 9 }, (_, n) => image(n)), pastedText: "" },
      { images: [image(1, { bytes: LIMITS.imageBytes + 1 })], pastedText: "" },
      { images: [], pastedText: "x".repeat(LIMITS.textLength + 1) },
      { images: [], pastedText: "   " },
      { images: [image(1, { height: 30_000 }), image(2, { height: 30_000 })], pastedText: "" },
      { images: [image(1, { width: 3_000 })], pastedText: "" },
      { images: [image(1, { width: 1, height: 30_001 })], pastedText: "" },
    ];
    for (const job of refusals) {
      expect(await startJob(deps(), { ...job, clientElapsedMs: 0 })).toMatchObject({ ok: false });
    }
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from {{schema}}.jobs",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe("confirmUploads", () => {
  it("queues the job once every image is stored as declared", async () => {
    const one = await webp(1080, 2400, 10);
    const two = await webp(1080, 6000, 20);
    const started = await startJob(deps(), {
      images: [one.meta, two.meta],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    const paths = (await images(started.jobId)).map((row) => row.storage_path);
    await storage.put(paths[0]!, one.bytes, "image/webp");
    await storage.put(paths[1]!, two.bytes, "image/webp");

    expect(await confirmUploads(deps(), started.jobId)).toEqual({ ok: true });
    expect(await loadJob(db, started.jobId)).toMatchObject({ state: "queued" });
  });

  it("leaves the job uploading and lists each image missing or of the wrong size, reading no bytes", async () => {
    const real = await Promise.all([10, 20, 30].map((shade) => webp(1080, 2400, shade)));
    const started = await startJob(deps(), {
      images: real.map((shot) => shot.meta),
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    const rows = await images(started.jobId);
    await storage.put(rows[0]!.storage_path, real[0]!.bytes, "image/webp");
    await storage.put(rows[1]!.storage_path, real[1]!.bytes.subarray(1), "image/webp");
    // Nothing arrives for the last.
    const read: string[] = [];
    const watched = {
      ...storage,
      get: async (path: string) => {
        read.push(path);
        return storage.get(path);
      },
    };

    expect(await confirmUploads({ db, clock, storage: watched }, started.jobId)).toEqual({
      ok: false,
      reason: "missing",
      missing: [rows[1]!.id, rows[2]!.id],
    });
    expect(await loadJob(db, started.jobId)).toMatchObject({ state: "uploading" });
    expect(read).toEqual([]);
  });

  it("reports the timeout when the job runs out of time while its files are being checked", async () => {
    const one = await webp(1080, 2400, 10);
    const started = await startJob(deps(), {
      images: [one.meta],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    await storage.put((await images(started.jobId))[0]!.storage_path, one.bytes, "image/webp");
    // As the daily backstop or a status read might, while confirm is checking sizes.
    const racing = {
      ...storage,
      stat: async (path: string) => {
        await db.query("update {{schema}}.jobs set state = 'upload_failed' where id = $1", [
          started.jobId,
        ]);
        return storage.stat(path);
      },
    };

    expect(await confirmUploads({ db, clock, storage: racing }, started.jobId)).toEqual({
      ok: false,
      reason: "upload-failed",
    });
  });

  it("fails a job confirmed after its upload timeout instead of queueing it", async () => {
    const one = await webp(1080, 2400, 10);
    const started = await startJob(deps(), {
      images: [one.meta],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    await storage.put((await images(started.jobId))[0]!.storage_path, one.bytes, "image/webp");
    clock.advance(15 * 60_000 + 1);

    expect(await confirmUploads(deps(), started.jobId)).toEqual({
      ok: false,
      reason: "upload-failed",
    });
    expect(await loadJob(db, started.jobId)).toMatchObject({ state: "upload_failed" });
  });

  it("refuses a job that is not uploading, and one that does not exist", async () => {
    const started = await startJob(deps(), {
      images: [],
      pastedText: "a post",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);

    expect(await confirmUploads(deps(), started.jobId)).toEqual({
      ok: false,
      reason: "not-uploading",
    });
    expect(await confirmUploads(deps(), "not-a-uuid")).toEqual({ ok: false, reason: "not-found" });
  });
});
