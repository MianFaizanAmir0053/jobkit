import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { startJob } from "@/core/intake/jobs";
import { loadJob } from "@/core/platform/jobs";
import { claimJob, runJob, stageOutput } from "@/core/platform/runner";
import { createTestDb } from "@/server/db/testDb";

import { extractStage } from "./extract";
import { chosenRole, confirmPost, pickRole, skipRolePick } from "./owner";
import type { JobRecord } from "./record";

/* The owner's answers to extraction: extraction AC6 and AC7, and B9's rows extraction owns. */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;

const RECORDS = join(process.cwd(), "evals", "synthetic", "records");
function fixture(id: string): JobRecord {
  return JSON.parse(readFileSync(join(RECORDS, `${id}.json`), "utf8")) as JobRecord;
}

function pipeline() {
  return {
    extract: extractStage({
      db,
      storage,
      random: { bytes: (length: number) => new Uint8Array(length) },
      models: { db, clock, llmFor: () => llm, guard: async () => ({ ok: true as const }) },
    }),
  };
}

/** A paste-only job run through extract with the fake model's answer. */
async function extracted(record: JobRecord): Promise<string> {
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: "a post", clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  await run(started.jobId, record);
  return started.jobId;
}

async function run(id: string, record: JobRecord): Promise<void> {
  llm = fakeLlm([answer(record)]);
  const deps = { db, clock, pipeline: pipeline() };
  const lease = await claimJob(deps, id);
  if (!lease) throw new Error("not claimed");
  await runJob(deps, lease);
}

const stateOf = async (id: string) => {
  const job = (await loadJob(db, id))!;
  return { state: job.state, pending: job.pendingStage };
};

const notAPost = (): JobRecord => ({ ...fixture("S01-email-simple"), post_kind: "not_a_job_post" });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-owner-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("confirmPost", () => {
  it("sends a post stopped as not a job post back to extract, which runs again with a new input", async () => {
    const id = await extracted(notAPost());
    expect(await stateOf(id)).toEqual({ state: "stopped", pending: null });
    const stopped = (await stageOutput(db, id, "extract"))!;

    expect(await confirmPost({ db, clock }, id)).toEqual({ ok: true });
    expect(await stateOf(id)).toEqual({ state: "extracting", pending: "extract" });

    // The model may still call it no post; with the owner's word the chain goes on.
    await run(id, notAPost());
    expect(await stateOf(id)).toMatchObject({ state: "failed", pending: "eligibility" });
    const { rows } = await db.query<{ input_hash: string; outcome: string }>(
      `select input_hash, outcome from {{schema}}.job_stage_runs
        where job_id = $1 and stage = 'extract' order by id`,
      [id],
    );
    expect(rows.map((row) => row.outcome)).toEqual(["ok", "ok"]);
    expect(rows[0]!.input_hash).not.toBe(rows[1]!.input_hash);
    expect((await stageOutput(db, id, "extract"))!.outputHash).not.toBe(stopped.outputHash);
    expect(llm.calls[0]!.system).toContain("confirmed that it is a job post");
  });

  it("refuses a stop for language, a job not stopped, a post confirmed already and an unknown job", async () => {
    const urdu = await extracted(fixture("S08-urdu"));
    expect(await stateOf(urdu)).toEqual({ state: "stopped", pending: null });
    expect(await confirmPost({ db, clock }, urdu)).toEqual({
      ok: false,
      reason: "not-a-post-stop",
    });
    expect(await stateOf(urdu)).toEqual({ state: "stopped", pending: null });

    const picking = await extracted(fixture("S07-two-roles"));
    expect(await confirmPost({ db, clock }, picking)).toEqual({
      ok: false,
      reason: "not-a-post-stop",
    });

    const id = await extracted(notAPost());
    expect(await confirmPost({ db, clock }, id)).toEqual({ ok: true });
    expect(await confirmPost({ db, clock }, id)).toEqual({ ok: false, reason: "not-a-post-stop" });

    expect(await confirmPost({ db, clock }, "33333333-3333-4333-8333-333333333333")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("confirmPost after no role was found", () => {
  it("reads the post again once, then leaves Skip as the only way on", async () => {
    const noRole = (): JobRecord => ({ ...fixture("S01-email-simple"), roles: [] });
    const id = await extracted(noRole());
    expect(await stateOf(id)).toEqual({ state: "stopped", pending: null });

    expect(await confirmPost({ db, clock }, id)).toEqual({ ok: true });
    await run(id, noRole());

    expect(await stateOf(id)).toEqual({ state: "stopped", pending: null });
    expect(await confirmPost({ db, clock }, id)).toEqual({ ok: false, reason: "not-a-post-stop" });
  });
});

describe("pickRole", () => {
  it("goes on with the role the owner picks, each role keeping its own contact", async () => {
    const id = await extracted(fixture("S07-two-roles"));
    expect(await stateOf(id)).toEqual({ state: "needs_role_pick", pending: null });
    expect(await chosenRole(db, id)).toBeNull();

    expect(await pickRole({ db, clock }, id, "P2")).toEqual({ ok: true });

    expect(await stateOf(id)).toEqual({ state: "checking", pending: "eligibility" });
    const role = await chosenRole(db, id);
    expect(role?.id).toBe("P2");
    expect(role?.route.address).toBe("ml@example.com");
  });

  it("refuses a role the post does not have, and a job not waiting for a pick", async () => {
    const id = await extracted(fixture("S07-two-roles"));
    expect(await pickRole({ db, clock }, id, "P3")).toEqual({ ok: false, reason: "no-such-role" });
    expect(await stateOf(id)).toEqual({ state: "needs_role_pick", pending: null });

    expect(await pickRole({ db, clock }, id, "P1")).toEqual({ ok: true });
    expect(await pickRole({ db, clock }, id, "P2")).toEqual({ ok: false, reason: "not-waiting" });
    expect((await chosenRole(db, id))?.id).toBe("P1");
  });
});

describe("a pick and the extraction it was made on", () => {
  it("picks the right role even when the model gave two roles one ID", async () => {
    const record = fixture("S07-two-roles");
    record.roles[1]!.id = "P1";
    const id = await extracted(record);

    expect(await pickRole({ db, clock }, id, "P2")).toEqual({ ok: true });
    expect((await chosenRole(db, id))?.route.address).toBe("ml@example.com");
  });

  it("is ignored once extract reads the post again, a single role then going on by itself", async () => {
    const id = await extracted(fixture("S07-two-roles"));
    expect(await pickRole({ db, clock }, id, "P2")).toEqual({ ok: true });
    // As after new screenshots: extract runs again, on a new input, and finds one role.
    await db.query(
      `update {{schema}}.jobs set state = 'extracting', pending_stage = 'extract',
         post_confirmed_at = $2 where id = $1`,
      [id, clock.now()],
    );
    await run(id, fixture("S01-email-simple"));

    expect((await chosenRole(db, id))?.route.address).toBe("jobs@example.com");
  });
});

describe("chosenRole", () => {
  it("is a post's only role without any pick", async () => {
    const id = await extracted(fixture("S01-email-simple"));
    expect((await chosenRole(db, id))?.id).toBe("P1");
  });
});

describe("skipRolePick", () => {
  it("closes a job waiting for a role pick, and nothing else", async () => {
    const id = await extracted(fixture("S07-two-roles"));
    expect(await skipRolePick({ db, clock }, id)).toEqual({ ok: true });
    expect(await stateOf(id)).toEqual({ state: "closed", pending: null });
    expect(await skipRolePick({ db, clock }, id)).toEqual({ ok: false, reason: "not-waiting" });
  });
});
