import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { Db, QueryResult, Row } from "@/core/ports";
import { loadJob } from "@/core/platform/jobs";
import { createTestDb } from "@/server/db/testDb";

import { SPEND_LIMITS } from "@/core/ledger/spend";

import {
  CAP_REACHED,
  confirmUploads,
  type ImageMeta,
  LIMITS,
  reissueUploads,
  startJob,
  uploadAgain,
} from "./jobs";

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
    `delete from {{schema}}.model_calls; delete from {{schema}}.upload_attempts;
     delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs`,
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

async function attempts(jobId: string) {
  const { rows } = await db.query<{
    files: number;
    bytes: number;
    outcome: string | null;
    started_at: Date;
    ended_at: Date | null;
  }>(
    `select files, bytes, outcome, started_at, ended_at from {{schema}}.upload_attempts
      where job_id = $1 order by started_at, id`,
    [jobId],
  );
  return rows;
}

describe("how a job came in", () => {
  it("records its input kind, and the links its post gives, stored and never fetched (intake AC5)", async () => {
    const fetched: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetched.push(String(input));
      throw new Error("intake fetches nothing");
    }) as typeof fetch;
    try {
      const started = await startJob(deps(), {
        images: [],
        pastedText:
          "Senior engineer, remote. Apply: https://www.linkedin.com/jobs/view/4012345678/?ref=feed. " +
          "More at www.northwind.example/careers, or (https://jobs.example.com/a). " +
          "Again: https://www.linkedin.com/jobs/view/4012345678/?ref=feed",
        sharedUrl: "https://lnkd.in/abc",
        clientElapsedMs: 0,
        inputKind: "share",
      });

      if (!started.ok) throw new Error(started.message);
      const { rows } = await db.query<{ input_kind: string; post_links: string[] }>(
        "select input_kind, post_links from {{schema}}.jobs where id = $1",
        [started.jobId],
      );
      expect(rows).toEqual([
        {
          input_kind: "share",
          post_links: [
            "https://lnkd.in/abc",
            "https://www.linkedin.com/jobs/view/4012345678/?ref=feed",
            "www.northwind.example/careers",
            "https://jobs.example.com/a",
          ],
        },
      ]);
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("takes a job from the New job page with no links as such", async () => {
    const started = await startJob(deps(), {
      images: [image(1)],
      pastedText: "",
      clientElapsedMs: 0,
    });

    if (!started.ok) throw new Error(started.message);
    const { rows } = await db.query<{ input_kind: string; post_links: string[] }>(
      "select input_kind, post_links from {{schema}}.jobs where id = $1",
      [started.jobId],
    );
    expect(rows).toEqual([{ input_kind: "page", post_links: [] }]);
  });
});

describe("upload attempts", () => {
  it("logs each attempt with the files it carries, and its outcome once confirmed", async () => {
    const [one, two] = await Promise.all([webp(1080, 2400, 10), webp(1080, 2400, 20)]);
    const started = await startJob(deps(), {
      images: [one.meta, two.meta],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    expect(await attempts(started.jobId)).toEqual([
      {
        files: 2,
        bytes: one.bytes.length + two.bytes.length,
        outcome: null,
        started_at: clock.now(),
        ended_at: null,
      },
    ]);

    const paths = (await images(started.jobId)).map((row) => row.storage_path);
    await storage.put(paths[0]!, one.bytes, "image/webp");
    await storage.put(paths[1]!, two.bytes, "image/webp");
    clock.advance(30_000);
    expect(await confirmUploads(deps(), started.jobId)).toEqual({ ok: true });

    expect(await attempts(started.jobId)).toMatchObject([{ outcome: "ok", ended_at: clock.now() }]);
  });

  it("logs none for a job with nothing to upload", async () => {
    const started = await startJob(deps(), {
      images: [],
      pastedText: "a post",
      clientElapsedMs: 0,
    });

    if (!started.ok) throw new Error(started.message);
    expect(await attempts(started.jobId)).toEqual([]);
  });
});

describe("reissueUploads", () => {
  it("gives fresh URLs for the files not stored as declared, and only those, as a new attempt", async () => {
    const real = await Promise.all([10, 20, 30].map((shade) => webp(1080, 2400, shade)));
    const started = await startJob(deps(), {
      images: real.map((each) => each.meta),
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    const rows = await images(started.jobId);
    await storage.put(rows[0]!.storage_path, real[0]!.bytes, "image/webp");
    await storage.put(rows[1]!.storage_path, real[1]!.bytes.subarray(1), "image/webp");
    clock.advance(60_000);

    const reissued = await reissueUploads(deps(), started.jobId);

    expect(reissued).toEqual({
      ok: true,
      uploads: [
        { imageId: rows[1]!.id, url: expect.any(String) },
        { imageId: rows[2]!.id, url: expect.any(String) },
      ],
    });
    // The file of the wrong size is gone, so its fresh URL can take the right one.
    expect(await storage.stat(rows[1]!.storage_path)).toBeNull();
    expect(await attempts(started.jobId)).toEqual([
      expect.objectContaining({ files: 3, outcome: "failed", ended_at: clock.now() }),
      expect.objectContaining({
        files: 2,
        bytes: real[1]!.bytes.length + real[2]!.bytes.length,
        outcome: null,
        started_at: clock.now(),
      }),
    ]);

    await storage.put(rows[1]!.storage_path, real[1]!.bytes, "image/webp");
    await storage.put(rows[2]!.storage_path, real[2]!.bytes, "image/webp");
    expect(await confirmUploads(deps(), started.jobId)).toEqual({ ok: true });
    expect((await attempts(started.jobId)).map((attempt) => attempt.outcome)).toEqual([
      "failed",
      "ok",
    ]);
  });

  it("gives no URL when every file arrived, so the phone goes on to confirm", async () => {
    const one = await webp(1080, 2400, 10);
    const started = await startJob(deps(), {
      images: [one.meta],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    await storage.put((await images(started.jobId))[0]!.storage_path, one.bytes, "image/webp");

    expect(await reissueUploads(deps(), started.jobId)).toEqual({ ok: true, uploads: [] });
    expect((await attempts(started.jobId)).map((attempt) => attempt.outcome)).toEqual([null]);
  });

  it("refuses a job that is not uploading, one past its upload time, and one that does not exist", async () => {
    const pasted = await startJob(deps(), { images: [], pastedText: "a post", clientElapsedMs: 0 });
    const late = await startJob(deps(), { images: [image(1)], pastedText: "", clientElapsedMs: 0 });
    if (!pasted.ok || !late.ok) throw new Error("not started");
    clock.advance(15 * 60_000 + 1);

    expect(await reissueUploads(deps(), pasted.jobId)).toEqual({
      ok: false,
      reason: "not-uploading",
    });
    expect(await reissueUploads(deps(), late.jobId)).toEqual({
      ok: false,
      reason: "upload-failed",
    });
    expect(await reissueUploads(deps(), "not-a-uuid")).toEqual({ ok: false, reason: "not-found" });
    expect(await reissueUploads(deps(), "11111111-1111-4111-8111-111111111111")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("uploadAgain", () => {
  /** A job whose upload ran out of time, one of its two screenshots stored. */
  async function failedUpload(): Promise<{ jobId: string; arrived: string }> {
    const one = await webp(1080, 2400, 10);
    const started = await startJob(deps(), {
      images: [one.meta, image(2)],
      pastedText: "a post",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    const arrived = (await images(started.jobId))[0]!.storage_path;
    await storage.put(arrived, one.bytes, "image/webp");
    clock.advance(15 * 60_000 + 1);
    expect(await confirmUploads(deps(), started.jobId)).toEqual({
      ok: false,
      reason: "upload-failed",
    });
    return { jobId: started.jobId, arrived };
  }

  it("replaces a failed upload's screenshots, starts its 15 minutes again, and queues the job once they arrive", async () => {
    const { jobId, arrived } = await failedUpload();
    clock.advance(60_000);
    const fresh = await webp(1080, 2400, 20);

    const again = await uploadAgain(deps(), jobId, [fresh.meta]);
    if (!again.ok) throw new Error(JSON.stringify(again));

    expect(again).toEqual({ ok: true, jobId, uploads: [expect.any(Object)] });
    expect(await loadJob(db, jobId)).toMatchObject({
      state: "uploading",
      stateChangedAt: clock.now(),
    });
    // It keeps its pasted text.
    const kept = await db.query<{ pasted_text: string }>(
      "select pasted_text from {{schema}}.jobs where id = $1",
      [jobId],
    );
    expect(kept.rows).toEqual([{ pasted_text: "a post" }]);
    const rows = await images(jobId);
    expect(rows).toEqual([
      expect.objectContaining({
        id: again.uploads[0]!.imageId,
        position: 0,
        bytes: fresh.meta.bytes,
      }),
    ]);
    // Nothing of the failed upload is kept.
    expect(await storage.stat(arrived)).toBeNull();
    // The failed attempt stays failed; a new one carries the screenshots chosen again.
    expect(await attempts(jobId)).toEqual([
      expect.objectContaining({ files: 2, outcome: "failed" }),
      expect.objectContaining({ files: 1, bytes: fresh.meta.bytes, outcome: null }),
    ]);
    // The phone uploads them, and the job is queued as a new one is.
    await storage.put(rows[0]!.storage_path, fresh.bytes, "image/webp");
    expect(await confirmUploads(deps(), jobId)).toEqual({ ok: true });
    expect(await loadJob(db, jobId)).toMatchObject({ state: "queued" });
  });

  it("sends the same screenshots again from the start while their upload runs, as after an answer that was lost", async () => {
    const { jobId } = await failedUpload();
    const fresh = [await webp(1080, 2400, 20), await webp(1080, 2400, 30)];
    const first = await uploadAgain(
      deps(),
      jobId,
      fresh.map((shot) => shot.meta),
    );
    if (!first.ok) throw new Error(JSON.stringify(first));
    const began = (await loadJob(db, jobId))!.stateChangedAt;
    // The first screenshot arrived; the page never learned its URLs, or lost the upload.
    const stored = (await images(jobId))[0]!.storage_path;
    await storage.put(stored, fresh[0]!.bytes, "image/webp");
    clock.advance(60_000);

    const again = await uploadAgain(
      deps(),
      jobId,
      fresh.map((shot) => shot.meta),
    );

    // The same rows, each with a fresh URL in order, and nothing stored to stand in the way.
    expect(again).toEqual({
      ok: true,
      jobId,
      uploads: first.uploads.map((upload) => ({
        imageId: upload.imageId,
        url: expect.any(String),
      })),
    });
    expect(await storage.stat(stored)).toBeNull();
    // Within the same 15 minutes, as another attempt.
    expect(await loadJob(db, jobId)).toMatchObject({ state: "uploading", stateChangedAt: began });
    expect((await attempts(jobId)).map((attempt) => [attempt.files, attempt.outcome])).toEqual([
      [2, "failed"],
      [2, "failed"],
      [2, null],
    ]);
    // Other screenshots wait for the upload to run out of time.
    expect(await uploadAgain(deps(), jobId, [image(9)])).toEqual({
      ok: false,
      reason: "not-failed",
    });
  });

  it("fails again a job uploaded again that runs out of its new 15 minutes", async () => {
    const { jobId } = await failedUpload();
    clock.advance(60 * 60_000);
    expect(await uploadAgain(deps(), jobId, [image(3)])).toMatchObject({ ok: true });

    clock.advance(15 * 60_000 - 1);
    expect(await reissueUploads(deps(), jobId)).toMatchObject({ ok: true });
    clock.advance(2);
    expect(await confirmUploads(deps(), jobId)).toEqual({ ok: false, reason: "upload-failed" });
  });

  it("refuses a job whose upload has not failed, one that does not exist, and screenshots past the limits", async () => {
    const uploading = await startJob(deps(), {
      images: [image(1)],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!uploading.ok) throw new Error(uploading.message);
    expect(await uploadAgain(deps(), uploading.jobId, [image(2)])).toEqual({
      ok: false,
      reason: "not-failed",
    });
    expect(await uploadAgain(deps(), "not-a-uuid", [image(2)])).toEqual({
      ok: false,
      reason: "not-found",
    });

    const { jobId } = await failedUpload();
    const tooMany = Array.from({ length: LIMITS.images + 1 }, (_, i) => image(10 + i));
    for (const chosen of [tooMany, []]) {
      expect(await uploadAgain(deps(), jobId, chosen)).toEqual({
        ok: false,
        message: expect.any(String),
      });
    }
    expect(await loadJob(db, jobId)).toMatchObject({ state: "upload_failed" });
    expect(await images(jobId)).toHaveLength(2);
  });

  it("tells a page whose upload was begun again elsewhere as it asked for URLs, or confirmed, that its upload failed", async () => {
    // As the page asks, its upload runs out of time and another device presses Upload again.
    const begunAgain = (inner: Db, jobId: string, marker: string): Db => {
      let done = false;
      const wrap = (base: Db): Db => ({
        schema: base.schema,
        query: async <T extends Row = Row>(sql: string, params?: readonly unknown[]) => {
          if (!done && sql.includes(marker)) {
            done = true;
            await base.query(
              `update {{schema}}.jobs set state_changed_at = state_changed_at + interval '16 minutes'
                where id = $1`,
              [jobId],
            );
          }
          return base.query<T>(sql, params) as Promise<QueryResult<T>>;
        },
        exec: (sql) => base.exec(sql),
        tx: (fn) => base.tx((tx) => fn(wrap(tx))),
      });
      return wrap(inner);
    };
    const one = await webp(1080, 2400, 10);
    const asking = await startJob(deps(), {
      images: [image(1)],
      pastedText: "",
      clientElapsedMs: 0,
    });
    const confirming = await startJob(deps(), {
      images: [one.meta],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!asking.ok || !confirming.ok) throw new Error("not started");
    await storage.put((await images(confirming.jobId))[0]!.storage_path, one.bytes, "image/webp");

    // No URL for a screenshot its upload no longer has, and no attempt logged for it.
    expect(
      await reissueUploads(
        { db: begunAgain(db, asking.jobId, "for update"), clock, storage },
        asking.jobId,
      ),
    ).toEqual({ ok: false, reason: "upload-failed" });
    expect(await attempts(asking.jobId)).toHaveLength(1);
    // Not taken as confirmed, which the page would read as its job going on.
    expect(
      await confirmUploads(
        { db: begunAgain(db, confirming.jobId, "set state = $3"), clock, storage },
        confirming.jobId,
      ),
    ).toEqual({ ok: false, reason: "upload-failed" });
  });

  it("starts no upload again once this month's model calls reach the cap for new jobs", async () => {
    const { jobId } = await failedUpload();
    await db.query(
      `insert into {{schema}}.model_calls
         (stage, attempt, provider, requested_model, started_at, outcome, cost_usd,
          cost_provisional, price_known)
       values ('extract', 1, 'gemini', 'gemini-3.8-flash', $1, 'ok', $2, false, true)`,
      [clock.now(), SPEND_LIMITS.newJobsUsd],
    );

    expect(await uploadAgain(deps(), jobId, [image(3)])).toEqual({
      ok: false,
      message: CAP_REACHED,
    });
    expect(await loadJob(db, jobId)).toMatchObject({ state: "upload_failed" });
  });
});

describe("the monthly spend cap", () => {
  it("refuses a new job once this month's model calls reach the cap for new jobs, creating none", async () => {
    await db.query(
      `insert into {{schema}}.model_calls
         (stage, attempt, provider, requested_model, started_at, outcome, cost_usd,
          cost_provisional, price_known)
       values ('extract', 1, 'gemini', 'gemini-3.8-flash', $1, 'ok', $2, false, true)`,
      [clock.now(), SPEND_LIMITS.newJobsUsd],
    );

    expect(
      await startJob(deps(), { images: [], pastedText: "A job post", clientElapsedMs: 0 }),
    ).toEqual({ ok: false, message: CAP_REACHED });
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from {{schema}}.jobs",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe("the upload timeout and a shared link", () => {
  it("ends a job's open attempt as failed when its upload times out", async () => {
    const started = await startJob(deps(), {
      images: [image(1)],
      pastedText: "",
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);
    clock.advance(15 * 60_000 + 1);

    expect(await confirmUploads(deps(), started.jobId)).toEqual({
      ok: false,
      reason: "upload-failed",
    });

    expect(await attempts(started.jobId)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        ended_at: new Date(clock.now().getTime() - 1),
      }),
    ]);
  });

  it("keeps a job whose shared link is past the limit or holds a NUL, keeping only the links that fit", async () => {
    const started = await startJob(deps(), {
      images: [],
      pastedText: "A post: https://jobs.example.com/1",
      sharedUrl: `https://lnkd.in/${"x".repeat(2_100)}`,
      clientElapsedMs: 0,
      inputKind: "share",
    });
    if (!started.ok) throw new Error(started.message);
    const nul = await startJob(deps(), {
      images: [],
      pastedText: "Another post",
      sharedUrl: `https://lnkd.in/a${String.fromCharCode(0)}b`,
      clientElapsedMs: 0,
      inputKind: "share",
    });
    if (!nul.ok) throw new Error(nul.message);

    const { rows } = await db.query<{ post_links: string[] }>(
      "select post_links from {{schema}}.jobs where id = any($1) order by received_at, id",
      [[started.jobId, nul.jobId]],
    );
    expect(rows.map((row) => row.post_links).sort()).toEqual(
      [["https://jobs.example.com/1"], ["https://lnkd.in/ab"]].sort(),
    );
  });

  it("drops the characters that show nothing and only hide text, keeping the marks Urdu needs", async () => {
    const at = (...codes: number[]) => String.fromCodePoint(...codes);
    // Tag characters spell hidden words; overrides and isolates turn text around on screen.
    const hidden = at(0xe0049, 0xe0067, 0xe006e) + at(0x202e) + at(0x2066) + at(0x2069);
    // The right-to-left mark and the zero-width non-joiner are part of written Urdu.
    const urdu = `${at(0x0645, 0x06cc, 0x200c, 0x06ba)}${at(0x200f)}`;
    const started = await startJob(deps(), {
      images: [],
      pastedText: `We're hiring${hidden}. Apply at jobs@example.com ${urdu}`,
      clientElapsedMs: 0,
    });
    if (!started.ok) throw new Error(started.message);

    const { rows } = await db.query<{ pasted_text: string }>(
      "select pasted_text from {{schema}}.jobs where id = $1",
      [started.jobId],
    );
    expect(rows).toEqual([{ pasted_text: `We're hiring. Apply at jobs@example.com ${urdu}` }]);
  });
});
