import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { fakeGmail, type FakeGmail } from "@/adapters/fakeGmail";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { issueSession } from "@/core/platform/sessions";
import type { Db, QueryResult, Row } from "@/core/ports";
import { LATE_MS } from "@/core/review/kitSends";
import { approvalsKey } from "@/core/review/decisions";
import { jobView } from "@/core/review/jobView";
import { readyKit, resetKitBed } from "@/core/review/testKit";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { deliver, send, sendState, undo } from "./sendActions";

/* The routes of "Approve & send": the press, Undo, the page's nudge and the send's state (A20). */

const ORIGIN = "http://localhost:3000";
const POST = "Northwind Analytics is hiring. Apply to jobs@example.com.";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let gmail: FakeGmail;
let scheduled: (() => Promise<unknown>)[];

const deps = (database: Db = db) => ({
  db: database,
  clock,
  storage,
  config,
  gmail: async () => gmail,
  schedule: (task: () => Promise<unknown>) => {
    scheduled.push(task);
  },
  // The countdown passes on the test's clock.
  sleep: async (ms: number) => clock.advance(ms),
});

async function signedIn(): Promise<string> {
  const { token } = await issueSession(
    { db, clock, random: cryptoRandom },
    { kind: "google", label: "laptop" },
  );
  return token;
}

async function connectGmail(): Promise<void> {
  await db.query(
    `insert into {{schema}}.gmail_connection (id, email, refresh_token_sealed, scopes, connected_at)
     values (1, 'owner@example.com', 'sealed', '{}', $1)`,
    [clock.now()],
  );
}

function get(path: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, { headers });
}

function post(path: string, body: object, cookie?: string, origin = ORIGIN): NextRequest {
  const headers: Record<string, string> = { origin, "content-type": "application/json" };
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** The database, its first claim of a send failing as on a dropped connection. */
function droppingFirstClaim(inner: Db): Db {
  let dropped = false;
  const wrap = (base: Db): Db => ({
    schema: base.schema,
    query: <T extends Row = Row>(sql: string, params?: readonly unknown[]) => {
      if (!dropped && sql.includes("kit_sends") && sql.includes("for update")) {
        dropped = true;
        return Promise.reject<QueryResult<T>>(new Error("connection lost"));
      }
      return base.query<T>(sql, params);
    },
    exec: (sql) => base.exec(sql),
    tx: (fn) => base.tx((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

/** What the job page shows as the owner presses Send: the kit and the address. */
async function pressedOn(id: string) {
  const view = (await jobView({ db, clock }, id))!;
  return {
    kit: view.kitKey!,
    to: view.handoff!.to,
    uncertain: view.uncertain?.id ?? null,
    approved: approvalsKey(view.kitParts!, view.review!.decisions),
  };
}

/** Runs what the routes scheduled, as after() would once the response has gone. */
async function drain(): Promise<void> {
  while (scheduled.length > 0) await scheduled.shift()!();
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    "delete from {{schema}}.gmail_connection; delete from {{schema}}.sessions; delete from {{schema}}.owner",
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-send-route-"));
  storage = createLocalStorage({ root, origin: ORIGIN });
  gmail = fakeGmail();
  scheduled = [];
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/jobs/<id>/send", () => {
  it("schedules the send, which goes once the countdown is over", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);

    const response = await send(
      post(`/api/jobs/${id}/send`, await pressedOn(id), cookie),
      deps(),
      id,
    );

    expect(response.status).toBe(202);
    expect((await response.json()).send).toMatchObject({
      status: "scheduled",
      to: "jobs@example.com",
      leftMs: 10_000,
    });
    expect(gmail.sent).toEqual([]);
    await drain();
    expect(gmail.sent).toHaveLength(1);
    const state = await sendState(get(`/api/jobs/${id}/send`, cookie), deps(), id);
    expect((await state.json()).send).toMatchObject({ status: "sent", messageId: "m1" });
  });

  it("refuses while Gmail is not connected, from another site, or without a session", async () => {
    const cookie = await signedIn();
    const id = await readyKit({ db, clock, storage }, POST);
    const pressed = await pressedOn(id);

    const unconnected = await send(post(`/api/jobs/${id}/send`, pressed, cookie), deps(), id);
    expect(unconnected.status).toBe(409);
    expect(await unconnected.json()).toEqual({ error: "gmail-not-connected" });

    await connectGmail();
    const elsewhere = post(`/api/jobs/${id}/send`, pressed, cookie, "https://evil.example");
    expect((await send(elsewhere, deps(), id)).status).toBe(403);
    expect((await send(post(`/api/jobs/${id}/send`, pressed), deps(), id)).status).toBe(401);
    expect(scheduled).toEqual([]);
  });

  it("refuses while jobkit can no longer use the Gmail connection", async () => {
    const cookie = await signedIn();
    await connectGmail();
    await db.query("update {{schema}}.gmail_connection set refused_at = $1", [clock.now()]);
    const id = await readyKit({ db, clock, storage }, POST);

    const response = await send(
      post(`/api/jobs/${id}/send`, await pressedOn(id), cookie),
      deps(),
      id,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "gmail-refused" });
  });

  it("delivers though its first try met a dropped connection", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);
    const flaky = deps(droppingFirstClaim(db));

    await send(post(`/api/jobs/${id}/send`, await pressedOn(id), cookie), flaky, id);
    await drain();

    expect(gmail.sent).toHaveLength(1);
  });

  it("refuses as changed a press from a page that listed its marks rather than giving their key", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);

    const response = await send(
      post(`/api/jobs/${id}/send`, { ...(await pressedOn(id)), approved: ["sentence:S1"] }, cookie),
      deps(),
      id,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "changed" });
  });

  it("refuses a press from a page drawn on another kit", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);

    const response = await send(
      post(`/api/jobs/${id}/send`, { ...(await pressedOn(id)), kit: "another kit" }, cookie),
      deps(),
      id,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "changed" });
  });
});

describe("POST /api/jobs/<id>/send/undo and /deliver", () => {
  it("stops the send with Undo, so the page's nudge finds nothing to send", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);
    const pressed = await send(
      post(`/api/jobs/${id}/send`, await pressedOn(id), cookie),
      deps(),
      id,
    );
    const sendId = (await pressed.json()).send.id as string;

    const undone = await undo(post(`/api/jobs/${id}/send/undo`, { sendId }, cookie), deps(), id);
    expect(undone.status).toBe(200);

    clock.advance(10_000);
    const nudged = await deliver(
      post(`/api/jobs/${id}/send/deliver`, { sendId }, cookie),
      deps(),
      id,
    );
    expect((await nudged.json()).send).toMatchObject({ status: "cancelled" });
    await drain();
    expect(gmail.sent).toEqual([]);
  });

  it("answers with the send the page shows for the kit it names", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);
    const shown = await pressedOn(id);
    const pressed = await send(post(`/api/jobs/${id}/send`, shown, cookie), deps(), id);
    const sendId = (await pressed.json()).send.id as string;
    await undo(post(`/api/jobs/${id}/send/undo`, { sendId }, cookie), deps(), id);
    // The kit is drafted again: an undone send of the earlier kit says nothing about it.
    await db.query(
      `update {{schema}}.job_stage_runs set output_hash = 'drafted again'
        where job_id = $1 and stage = 'draft'`,
      [id],
    );
    const { kit: redrafted } = await pressedOn(id);

    const forNew = await sendState(
      get(`/api/jobs/${id}/send?kit=${redrafted}`, cookie),
      deps(),
      id,
    );
    const forOld = await sendState(
      get(`/api/jobs/${id}/send?kit=${shown.kit}`, cookie),
      deps(),
      id,
    );

    expect((await forNew.json()).send).toBeNull();
    expect((await forOld.json()).send).toMatchObject({ id: sendId, status: "cancelled" });
  });

  it("gives a send nothing delivered in time as not sent", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);
    await send(post(`/api/jobs/${id}/send`, await pressedOn(id), cookie), deps(), id);
    // The server restarted, and the page was closed.
    scheduled = [];
    clock.advance(10_000 + LATE_MS + 1);

    const state = await sendState(get(`/api/jobs/${id}/send`, cookie), deps(), id);

    expect((await state.json()).send).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/not sent/i),
    });
  });

  it("delivers on the page's nudge when the server lost its own", async () => {
    const cookie = await signedIn();
    await connectGmail();
    const id = await readyKit({ db, clock, storage }, POST);
    const pressed = await send(
      post(`/api/jobs/${id}/send`, await pressedOn(id), cookie),
      deps(),
      id,
    );
    const sendId = (await pressed.json()).send.id as string;
    // The server restarted: what after() held is gone.
    scheduled = [];

    // The page's countdown ends a moment before the server's.
    clock.advance(9_900);
    const nudged = await deliver(
      post(`/api/jobs/${id}/send/deliver`, { sendId }, cookie),
      deps(),
      id,
    );

    expect((await nudged.json()).send).toMatchObject({ status: "sent" });
    expect(gmail.sent).toHaveLength(1);
    const late = await undo(post(`/api/jobs/${id}/send/undo`, { sendId }, cookie), deps(), id);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "too-late" });
  });
});
