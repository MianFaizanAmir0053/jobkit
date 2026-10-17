import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { loadJob } from "@/core/platform/jobs";
import type { Pipeline } from "@/core/platform/runner";
import { issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { confirm, create, reissue } from "./intake";

const ORIGIN = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

// One stage, enough to see the pipeline start: it finds no job post.
const pipeline: Pipeline = {
  extract: {
    callsModel: true,
    input: () => ({}),
    run: async () => ({ ok: true, output: { post: false } }),
    next: () => ({ state: "stopped", pending: null }),
  },
};

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let scheduled: (() => Promise<unknown>)[];
const deps = () => ({
  db,
  clock,
  storage,
  config,
  pipeline,
  schedule: (task: () => Promise<unknown>) => {
    scheduled.push(task);
  },
});

const image = (n: number, bytes: number) => ({
  contentType: "image/webp",
  bytes,
  width: 1080,
  height: 2400,
  sha256: n.toString(16).padStart(64, "0"),
});

/** A real WebP and the metadata the phone would declare for it. */
async function webp(shade: number) {
  const bytes = new Uint8Array(
    await sharp({
      create: {
        width: 1080,
        height: 2400,
        channels: 3,
        background: { r: shade, g: shade, b: shade },
      },
    })
      .webp()
      .toBuffer(),
  );
  const meta = {
    contentType: "image/webp",
    bytes: bytes.length,
    width: 1080,
    height: 2400,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { bytes, meta };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.sessions; delete from {{schema}}.upload_attempts;
     delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-intake-route-"));
  storage = createLocalStorage({ root, origin: ORIGIN });
  scheduled = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function signedIn(kind: "google" | "paired" = "google"): Promise<string> {
  const { token } = await issueSession({ db, clock, random: cryptoRandom }, { kind, label: kind });
  return token;
}

function post(path: string, body: string, cookie?: string, origin = ORIGIN): NextRequest {
  const headers: Record<string, string> = { origin, "content-type": "application/json" };
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers, body });
}

const newJob = (body: object, cookie?: string) =>
  create(post("/api/jobs", JSON.stringify(body), cookie), deps());

describe("POST /api/jobs", () => {
  it("creates a job from metadata alone, with an upload URL for each image", async () => {
    const cookie = await signedIn();

    const response = await newJob(
      { images: [image(1, 5), image(2, 3)], pastedText: "", clientElapsedMs: 1200 },
      cookie,
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      jobId: string;
      uploads: unknown[];
      queued: boolean;
    };
    expect(created.uploads).toHaveLength(2);
    expect(created.queued).toBe(false);
    expect(await loadJob(db, created.jobId)).toMatchObject({
      state: "uploading",
      clientElapsedMs: 1200,
    });
    expect(scheduled).toHaveLength(0);
  });

  it("starts a paste-only job at once", async () => {
    const cookie = await signedIn();

    const response = await newJob(
      { images: [], pastedText: "A job post", clientElapsedMs: 0 },
      cookie,
    );

    expect(response.status).toBe(201);
    const { jobId } = (await response.json()) as { jobId: string };
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(await loadJob(db, jobId)).toMatchObject({ state: "stopped" });
  });

  it("answers a created job as created, even when its pipeline cannot start yet", async () => {
    const cookie = await signedIn();
    const broken = {
      ...deps(),
      schedule: () => {
        throw new Error("after() is unavailable");
      },
    };

    const response = await create(
      post(
        "/api/jobs",
        JSON.stringify({ images: [], pastedText: "A job post", clientElapsedMs: 0 }),
        cookie,
      ),
      broken,
    );

    expect(response.status).toBe(201);
    const { jobId } = (await response.json()) as { jobId: string };
    expect(await loadJob(db, jobId)).toMatchObject({ state: "queued" });
  });

  it("refuses what breaks intake's limits, with the message the page shows", async () => {
    const cookie = await signedIn();

    const response = await newJob(
      {
        images: Array.from({ length: 9 }, (_, n) => image(n, 10)),
        pastedText: "",
        clientElapsedMs: 0,
      },
      cookie,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "At most 8 screenshots per job. Remove some, or split the post into two jobs.",
    });
  });

  it("refuses a body over 64 KB, which could only be image bytes, and one of the wrong shape", async () => {
    const cookie = await signedIn();
    const huge = JSON.stringify({ images: [], pastedText: "x".repeat(70_000), clientElapsedMs: 0 });

    expect((await create(post("/api/jobs", huge, cookie), deps())).status).toBe(413);
    expect((await create(post("/api/jobs", "not json", cookie), deps())).status).toBe(400);
    expect((await newJob({ images: [{ bytes: "5" }], clientElapsedMs: 0 }, cookie)).status).toBe(
      400,
    );
  });

  it("refuses a request from another origin, without a session, or from a phone not yet approved (intake AC8)", async () => {
    const cookie = await signedIn();
    const body = JSON.stringify({ images: [], pastedText: "A job post", clientElapsedMs: 0 });

    expect(
      (await create(post("/api/jobs", body, cookie, "https://evil.example"), deps())).status,
    ).toBe(403);
    expect((await create(post("/api/jobs", body), deps())).status).toBe(401);
    expect((await create(post("/api/jobs", body, await signedIn("paired")), deps())).status).toBe(
      401,
    );
  });

  it("refuses a body declared over 64 KB before reading it", async () => {
    const cookie = await signedIn();
    const request = new NextRequest(`${ORIGIN}/api/jobs`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: `jobkit_session=${cookie}`,
        "content-length": String(64 * 1024 + 1),
      },
      body: JSON.stringify({ images: [], pastedText: "A job post", clientElapsedMs: 0 }),
    });

    expect((await create(request, deps())).status).toBe(413);
  });

  it("refuses a clock that says the phone held the job for more than a day", async () => {
    const cookie = await signedIn();

    expect(
      (
        await newJob(
          { images: [], pastedText: "A job post", clientElapsedMs: 24 * 60 * 60 * 1000 + 1 },
          cookie,
        )
      ).status,
    ).toBe(422);
    expect(
      (await newJob({ images: [], pastedText: "A job post", clientElapsedMs: 1.5 }, cookie)).status,
    ).toBe(400);
  });

  it("records the job as received when its request reached the route (intake AC10)", async () => {
    const cookie = await signedIn();
    const arrived = new Date(clock.now().getTime() - 3_000);
    const body = JSON.stringify({ images: [], pastedText: "A job post", clientElapsedMs: 700 });

    const response = await create(post("/api/jobs", body, cookie), deps(), arrived);

    const { jobId } = (await response.json()) as { jobId: string };
    expect(await loadJob(db, jobId)).toMatchObject({ receivedAt: arrived, clientElapsedMs: 700 });
  });
});

describe("POST /api/jobs/<id>/uploaded", () => {
  let screenshots: { bytes: Uint8Array; meta: ReturnType<typeof image> }[];

  async function started(cookie: string) {
    screenshots = [await webp(10), await webp(20)];
    const response = await newJob(
      { images: screenshots.map((shot) => shot.meta), pastedText: "", clientElapsedMs: 0 },
      cookie,
    );
    return (await response.json()) as {
      jobId: string;
      uploads: { imageId: string; url: string }[];
    };
  }

  const uploadTo = async (url: string, bytes: Uint8Array) => {
    const token = new URL(url).pathname.split("/").pop()!;
    expect(await storage.acceptSignedUpload(token, bytes)).toBe(true);
  };

  it("queues the job once every image arrived, and starts the pipeline", async () => {
    const cookie = await signedIn();
    const { jobId, uploads } = await started(cookie);
    await uploadTo(uploads[0]!.url, screenshots[0]!.bytes);
    await uploadTo(uploads[1]!.url, screenshots[1]!.bytes);

    const response = await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId);

    expect(response.status).toBe(202);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(await loadJob(db, jobId)).toMatchObject({ state: "stopped" });
  });

  it("lists the images still missing, leaving the job uploading", async () => {
    const cookie = await signedIn();
    const { jobId, uploads } = await started(cookie);
    await uploadTo(uploads[0]!.url, screenshots[0]!.bytes);

    const response = await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "missing", missing: [uploads[1]!.imageId] });
    expect(scheduled).toHaveLength(0);
  });

  it("refuses a body over 64 KB, which could only be image bytes", async () => {
    const cookie = await signedIn();
    const { jobId } = await started(cookie);

    const response = await confirm(
      post(`/api/jobs/${jobId}/uploaded`, "x".repeat(64 * 1024 + 1), cookie),
      deps(),
      jobId,
    );

    expect(response.status).toBe(413);
    expect(await loadJob(db, jobId)).toMatchObject({ state: "uploading" });
  });

  it("asks the page to try again when storage cannot say what arrived", async () => {
    const cookie = await signedIn();
    const { jobId } = await started(cookie);
    const failing = {
      ...deps(),
      storage: { ...storage, stat: () => Promise.reject(new Error("storage is down")) },
    };

    const response = await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), failing, jobId);

    expect(response.status).toBe(503);
    expect(await loadJob(db, jobId)).toMatchObject({ state: "uploading" });
  });

  it("says when the upload ran out of time, rather than that the job was confirmed", async () => {
    const cookie = await signedIn();
    const { jobId, uploads } = await started(cookie);
    await uploadTo(uploads[0]!.url, screenshots[0]!.bytes);
    await uploadTo(uploads[1]!.url, screenshots[1]!.bytes);
    clock.advance(15 * 60_000 + 1);

    const response = await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "upload-failed" });
    expect(scheduled).toHaveLength(0);
  });

  it("refuses a phone not yet approved (intake AC8)", async () => {
    const { jobId } = await started(await signedIn());
    const phone = await signedIn("paired");

    expect(
      (await confirm(post(`/api/jobs/${jobId}/uploaded`, "", phone), deps(), jobId)).status,
    ).toBe(401);
  });

  it("refuses a job that is not uploading, one that does not exist, and a request without a session", async () => {
    const cookie = await signedIn();
    const paste = await newJob(
      { images: [], pastedText: "A job post", clientElapsedMs: 0 },
      cookie,
    );
    const { jobId } = (await paste.json()) as { jobId: string };

    expect(
      (await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId)).status,
    ).toBe(409);
    expect(
      (await confirm(post("/api/jobs/x/uploaded", "", cookie), deps(), "not-a-uuid")).status,
    ).toBe(404);
    expect((await confirm(post(`/api/jobs/${jobId}/uploaded`, ""), deps(), jobId)).status).toBe(
      401,
    );
  });
});

describe("POST /api/jobs/<id>/upload-urls", () => {
  it("gives fresh URLs for the screenshots not yet stored, after which the job completes (intake AC7)", async () => {
    const cookie = await signedIn();
    const shots = [await webp(10), await webp(20)];
    const created = await newJob(
      {
        images: shots.map((shot) => shot.meta),
        pastedText: "",
        clientElapsedMs: 0,
        inputKind: "page",
      },
      cookie,
    );
    const { jobId, uploads } = (await created.json()) as {
      jobId: string;
      uploads: { imageId: string; url: string }[];
    };
    // The first screenshot arrived before the page reloaded; the second never did.
    const token = new URL(uploads[0]!.url).pathname.split("/").pop()!;
    expect(await storage.acceptSignedUpload(token, shots[0]!.bytes)).toBe(true);

    const response = await reissue(
      post(`/api/jobs/${jobId}/upload-urls`, "", cookie),
      deps(),
      jobId,
    );

    expect(response.status).toBe(200);
    const fresh = (await response.json()) as { uploads: { imageId: string; url: string }[] };
    expect(fresh.uploads.map((upload) => upload.imageId)).toEqual([uploads[1]!.imageId]);
    const again = new URL(fresh.uploads[0]!.url).pathname.split("/").pop()!;
    expect(await storage.acceptSignedUpload(again, shots[1]!.bytes)).toBe(true);
    expect(
      (await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId)).status,
    ).toBe(202);
  });

  it("refuses a job that is not uploading, one that does not exist, another origin, and no session", async () => {
    const cookie = await signedIn();
    const paste = await newJob(
      { images: [], pastedText: "A job post", clientElapsedMs: 0 },
      cookie,
    );
    const { jobId } = (await paste.json()) as { jobId: string };
    const ask = (id: string, who?: string, origin?: string) =>
      reissue(post(`/api/jobs/${id}/upload-urls`, "", who, origin), deps(), id);

    expect((await ask(jobId, cookie)).status).toBe(409);
    expect((await ask("not-a-uuid", cookie)).status).toBe(404);
    expect((await ask(jobId, cookie, "https://evil.example")).status).toBe(403);
    expect((await ask(jobId)).status).toBe(401);
  });

  it("refuses a body over 64 KB, which could only be image bytes", async () => {
    const cookie = await signedIn();
    const created = await newJob(
      { images: [image(1, 1_000)], pastedText: "", clientElapsedMs: 0 },
      cookie,
    );
    const { jobId } = (await created.json()) as { jobId: string };

    const response = await reissue(
      post(`/api/jobs/${jobId}/upload-urls`, "x".repeat(64 * 1024 + 1), cookie),
      deps(),
      jobId,
    );
    expect(response.status).toBe(413);
  });
});
