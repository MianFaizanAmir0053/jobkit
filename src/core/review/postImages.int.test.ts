import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb, insertTestJobs } from "@/server/db/testDb";

import { IMAGE_URL_SECONDS, postImages } from "./postImages";

/* The post's crop and screenshots, as the job page shows them: review spec, "Contact panel". */

const JOB = "55555555-5555-4555-8555-555555555555";
const CROP = `jobs/${JOB}/crops/a.png`;

let db: PgliteDb;
let root: string;
let storage: LocalStorage;

beforeAll(async () => {
  db = await createTestDb();
  await insertTestJobs(db, [JOB]);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jobkit-post-images-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(async () => {
  await db.exec("delete from {{schema}}.job_images");
  rmSync(root, { recursive: true, force: true });
});

/** A screenshot of the post, stored, at its place among the post's. */
async function screenshot(position: number): Promise<string> {
  const path = `jobs/${JOB}/${position}.webp`;
  await db.query(
    `insert into {{schema}}.job_images
       (id, job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
        tile_count, created_at, purge_after)
     values (gen_random_uuid(), $1, $2, 'post', $3, 'image/webp', 1080, 2400, 3, $4, 2, now(),
             now() + interval '30 days')`,
    [JOB, position, path, String(position).padStart(64, "0")],
  );
  await storage.put(path, new Uint8Array([1, 2, 3]), "image/webp");
  return path;
}

const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;

describe("postImages", () => {
  it("signs the crop and the post's screenshots, in their order, for 60 seconds", async () => {
    const second = await screenshot(1);
    const first = await screenshot(0);
    await storage.put(CROP, new Uint8Array([4]), "image/png");

    const images = await postImages({ db, storage }, JOB, { cropPath: CROP, screenshots: true });

    expect(IMAGE_URL_SECONDS).toBe(60);
    expect(storage.resolveSignedRead(tokenOf(images.crop!), Date.now())).toBe(CROP);
    expect(storage.resolveSignedRead(tokenOf(images.crop!), Date.now() + 61_000)).toBeNull();
    expect(
      images.screenshots.map((url) => storage.resolveSignedRead(tokenOf(url), Date.now())),
    ).toEqual([first, second]);
  });

  it("signs no screenshot unless the page shows them, and no crop it does not have", async () => {
    await screenshot(0);

    expect(await postImages({ db, storage }, JOB, { cropPath: null, screenshots: false })).toEqual({
      crop: null,
      screenshots: [],
    });
    expect(
      await postImages({ db, storage }, "not-a-uuid", { cropPath: CROP, screenshots: true }),
    ).toEqual({ crop: null, screenshots: [] });
  });
});
