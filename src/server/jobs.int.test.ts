import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { createJob, loadJob, moveJob } from "@/core/platform/jobs";
import type { Pipeline } from "@/core/platform/runner";
import { issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { advance } from "./jobs";

const ORIGIN = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

// One stage, enough to see the pipeline run: it finds no job post.
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
let scheduled: (() => Promise<unknown>)[];
const deps = () => ({
  db,
  clock,
  config,
  pipeline,
  schedule: (task: () => Promise<unknown>) => {
    scheduled.push(task);
  },
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
     delete from {{schema}}.job_leases; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs`,
  );
  clock = fakeClock();
  scheduled = [];
});

async function signedIn(): Promise<string> {
  const { token } = await issueSession(
    { db, clock, random: cryptoRandom },
    { kind: "google", label: "laptop" },
  );
  return token;
}

async function queuedJob(): Promise<string> {
  const id = await createJob(db, {
    state: "uploading",
    receivedAt: clock.now(),
    clientElapsedMs: 0,
  });
  await moveJob(db, id, { from: "uploading", to: "queued", pending: null, at: clock.now() });
  return id;
}

function post(id: string, cookie?: string, origin = ORIGIN): NextRequest {
  const headers: Record<string, string> = { origin };
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}/api/jobs/${id}/advance`, { method: "POST", headers });
}

describe("POST /api/jobs/<id>/advance", () => {
  it("claims a running job, answers 202 and runs the pipeline only after the response", async () => {
    const cookie = await signedIn();
    const id = await queuedJob();

    const response = await advance(post(id, cookie), deps(), id);

    expect(response.status).toBe(202);
    expect(await loadJob(db, id)).toMatchObject({ state: "queued" });
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(await loadJob(db, id)).toMatchObject({ state: "stopped", leaseId: null });
  });

  it("counts the invocation's time from when the request began, not from the claim", async () => {
    const cookie = await signedIn();
    const id = await queuedJob();
    // The request reached the route 61 seconds ago; extract's worst case no longer fits.
    const startedAt = new Date(clock.now().getTime() - 61_000);

    expect((await advance(post(id, cookie), deps(), id, startedAt)).status).toBe(202);
    await scheduled[0]!();

    expect(await loadJob(db, id)).toMatchObject({ state: "extracting", leaseId: null });
  });

  it("records the lease as starting when the request did, so the request's own time is never paused", async () => {
    const cookie = await signedIn();
    const id = await queuedJob();
    const startedAt = new Date(clock.now().getTime() - 1_500);

    await advance(post(id, cookie), deps(), id, startedAt);

    const { rows } = await db.query<{ claimed_at: Date }>(
      "select claimed_at from {{schema}}.job_leases where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ claimed_at: startedAt }]);
  });

  it("refuses a second advance while the first one's lease is live", async () => {
    const cookie = await signedIn();
    const id = await queuedJob();
    await advance(post(id, cookie), deps(), id);

    const second = await advance(post(id, cookie), deps(), id);

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "claimed" });
    expect(scheduled).toHaveLength(1);
  });

  it("refuses a job that is not running, and one that does not exist", async () => {
    const cookie = await signedIn();
    const uploading = await createJob(db, {
      state: "uploading",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    const missing = "99999999-9999-4999-8999-999999999999";

    const notRunning = await advance(post(uploading, cookie), deps(), uploading);
    expect(notRunning.status).toBe(409);
    expect(await notRunning.json()).toEqual({ error: "not-running" });
    expect((await advance(post(missing, cookie), deps(), missing)).status).toBe(404);
    expect((await advance(post("not-a-uuid", cookie), deps(), "not-a-uuid")).status).toBe(404);
    expect(scheduled).toHaveLength(0);
  });

  it("applies the upload timeout when it reads a job it cannot claim", async () => {
    const cookie = await signedIn();
    const id = await createJob(db, {
      state: "uploading",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    clock.advance(16 * 60_000);

    const response = await advance(post(id, cookie), deps(), id);

    expect(response.status).toBe(409);
    expect(await loadJob(db, id)).toMatchObject({ state: "upload_failed" });
  });

  it("refuses a request from another origin, or without a session", async () => {
    const cookie = await signedIn();
    const id = await queuedJob();

    expect((await advance(post(id, cookie, "https://evil.example"), deps(), id)).status).toBe(403);
    expect((await advance(post(id), deps(), id)).status).toBe(401);
    expect(await loadJob(db, id)).toMatchObject({ state: "queued", leaseId: null });
  });
});
