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
  /** Where each signed URL leads, in the order given. */
  const pathsOf = (urls: readonly string[]) =>
    urls.map((url) => storage.resolveSignedRead(tokenOf(url), Date.now()));

  it("signs the crop for 60 seconds, and no screenshot while it shows unless asked", async () => {
    await screenshot(0);
    await storage.put(CROP, new Uint8Array([4]), "image/png");

    const images = await postImages({ db, storage }, JOB, {
      cropPath: CROP,
      screenshots: "without-crop",
    });

    expect(IMAGE_URL_SECONDS).toBe(60);
    expect(storage.resolveSignedRead(tokenOf(images.crop!), Date.now())).toBe(CROP);
    expect(storage.resolveSignedRead(tokenOf(images.crop!), Date.now() + 61_000)).toBeNull();
    expect(images.screenshots).toEqual([]);
  });

  it("signs the post's screenshots in their order, each with its row, place and size", async () => {
    const second = await screenshot(1);
    const first = await screenshot(0);
    await storage.put(CROP, new Uint8Array([4]), "image/png");

    const images = await postImages({ db, storage }, JOB, {
      cropPath: CROP,
      screenshots: "always",
    });

    expect(pathsOf(images.screenshots.map((shot) => shot.url))).toEqual([first, second]);
    expect(
      images.screenshots.map(({ position, width, height }) => ({ position, width, height })),
    ).toEqual([
      { position: 0, width: 1080, height: 2400 },
      { position: 1, width: 1080, height: 2400 },
    ]);
    expect(new Set(images.screenshots.map((shot) => shot.id)).size).toBe(2);
  });

  it("puts first the screenshot the contact was read on", async () => {
    const paths = [await screenshot(0), await screenshot(1), await screenshot(2)];

    const images = await postImages({ db, storage }, JOB, {
      cropPath: null,
      screenshots: "always",
      first: 2,
    });

    expect(pathsOf(images.screenshots.map((shot) => shot.url))).toEqual([
      paths[2],
      paths[0],
      paths[1],
    ]);
  });

  it("shows the screenshots when there is no crop to show: none made, or one storage cannot sign", async () => {
    const path = await screenshot(0);
    const shown = async (cropPath: string | null) => {
      const images = await postImages({ db, storage }, JOB, {
        cropPath,
        screenshots: "without-crop",
      });
      return { crop: images.crop, screenshots: pathsOf(images.screenshots.map((s) => s.url)) };
    };

    expect(await shown(null)).toEqual({ crop: null, screenshots: [path] });
    // Recorded, but no longer in storage, as after a purge.
    expect(await shown(CROP)).toEqual({ crop: null, screenshots: [path] });
  });

  it("signs no screenshot once the kit has gone, crop or none", async () => {
    await screenshot(0);

    expect(
      await postImages({ db, storage }, JOB, { cropPath: null, screenshots: "never" }),
    ).toEqual({ crop: null, screenshots: [] });
  });

  it("signs the crop for a job named in capitals", async () => {
    await storage.put(CROP, new Uint8Array([4]), "image/png");

    const images = await postImages({ db, storage }, JOB.toUpperCase(), {
      cropPath: CROP,
      screenshots: "without-crop",
    });

    expect(storage.resolveSignedRead(tokenOf(images.crop!), Date.now())).toBe(CROP);
  });

  it("signs no crop but one of this job's", async () => {
    for (const path of [
      "jobs/66666666-6666-4666-8666-666666666666/crops/a.png",
      "profile/cv.pdf",
      `jobs/${JOB}/0.webp`,
    ]) {
      await storage.put(path, new Uint8Array([4]), "image/png");

      expect(
        (await postImages({ db, storage }, JOB, { cropPath: path, screenshots: "without-crop" }))
          .crop,
      ).toBeNull();
    }
  });

  it("signs nothing for a job that is not one", async () => {
    expect(
      await postImages({ db, storage }, "not-a-uuid", { cropPath: CROP, screenshots: "always" }),
    ).toEqual({ crop: null, screenshots: [] });
  });
});
