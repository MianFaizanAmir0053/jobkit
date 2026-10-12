import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
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

import { confirm, create } from "./intake";

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

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.sessions; delete from {{schema}}.job_stage_runs;
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

async function signedIn(): Promise<string> {
  const { token } = await issueSession(
    { db, clock, random: cryptoRandom },
    { kind: "google", label: "laptop" },
  );
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

  it("refuses a request from another origin, or without a session", async () => {
    const cookie = await signedIn();
    const body = JSON.stringify({ images: [], pastedText: "A job post", clientElapsedMs: 0 });

    expect(
      (await create(post("/api/jobs", body, cookie, "https://evil.example"), deps())).status,
    ).toBe(403);
    expect((await create(post("/api/jobs", body), deps())).status).toBe(401);
  });
});

describe("POST /api/jobs/<id>/uploaded", () => {
  async function started(cookie: string) {
    const response = await newJob(
      { images: [image(1, 5), image(2, 3)], pastedText: "", clientElapsedMs: 0 },
      cookie,
    );
    return (await response.json()) as {
      jobId: string;
      uploads: { imageId: string; url: string }[];
    };
  }

  const uploadTo = async (url: string, text: string) => {
    const token = new URL(url).pathname.split("/").pop()!;
    expect(await storage.acceptSignedUpload(token, new TextEncoder().encode(text))).toBe(true);
  };

  it("queues the job once every image arrived, and starts the pipeline", async () => {
    const cookie = await signedIn();
    const { jobId, uploads } = await started(cookie);
    await uploadTo(uploads[0]!.url, "hello");
    await uploadTo(uploads[1]!.url, "abc");

    const response = await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId);

    expect(response.status).toBe(202);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(await loadJob(db, jobId)).toMatchObject({ state: "stopped" });
  });

  it("lists the images still missing, leaving the job uploading", async () => {
    const cookie = await signedIn();
    const { jobId, uploads } = await started(cookie);
    await uploadTo(uploads[0]!.url, "hello");

    const response = await confirm(post(`/api/jobs/${jobId}/uploaded`, "", cookie), deps(), jobId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "missing", missing: [uploads[1]!.imageId] });
    expect(scheduled).toHaveLength(0);
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
