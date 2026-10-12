import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, failure, fakeLlm, type FakeLlm } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { confirmUploads, startJob } from "@/core/intake/jobs";
import type { ImageMeta } from "@/core/intake/limits";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import {
  claimJob,
  type Pipeline,
  runJob,
  type StageDefinition,
  stageOutput,
} from "@/core/platform/runner";
import type { Random } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { agreement } from "./addressRead";
import {
  ADDRESS_READ,
  ADDRESS_READ_RULES,
  type AddressReadOutput,
  addressReadStage,
} from "./addressReadStage";
import { CROP } from "./crop";
import { extractStage } from "./extract";
import type { JobRecord } from "./record";

/*
 * Extraction's `address_read` stage on the fake models, run beside a stub
 * draft as the runner runs it (extraction spec, "Stage address_read", AC9,
 * AC10 and AC12).
 */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;
let counter = 0;

const random: Random = {
  bytes: (length) => Uint8Array.from({ length }, () => counter++ % 256),
};

/** The models, with or without a Gemini key on this machine. */
function models(gemini: "set" | "missing" = "set"): ModelCallDeps {
  return {
    db,
    clock,
    llmFor: (model) => {
      if (gemini === "missing" && model.startsWith("gemini-")) {
        throw new Error("GEMINI_EVALS_API_KEY is not set, so the model cannot run here");
      }
      return llm;
    },
    guard: async () => ({ ok: true }),
    limits: {
      idleMs: 1_000,
      totalMs: 5_000,
      maxRetryWaitMs: 10,
      defaultRetryWaitMs: 5,
      countMs: 100,
    },
  };
}

/** A stage that only moves the job on, standing in for the ones not under test. */
function passing(next: ReturnType<NonNullable<StageDefinition["next"]>>): StageDefinition {
  return {
    callsModel: false,
    input: () => ({}),
    run: async () => ({ ok: true, output: {} }),
    next: () => next,
  };
}

function pipeline(gemini: "set" | "missing" = "set"): Pipeline {
  return {
    extract: extractStage({ db, storage, random, models: models(gemini) }),
    eligibility: passing({ state: "drafting", pending: "draft" }),
    draft: {
      ...passing({ state: "judging", pending: "judge" }),
      alongside: () => ["address_read"],
    },
    judge: passing({ state: "kit_ready", pending: null }),
    address_read: addressReadStage({ db, storage, random, models: models(gemini) }),
  };
}

const RECORDS = join(process.cwd(), "evals", "synthetic", "records");
const fixture = (id: string): JobRecord =>
  JSON.parse(readFileSync(join(RECORDS, `${id}.json`), "utf8")) as JobRecord;

/** S01, whose contact is jobs@example.com, with the contact's box where a test puts it. */
function withBox(box: JobRecord["roles"][number]["route"]["box"]): JobRecord {
  const record = fixture("S01-email-simple");
  record.roles[0]!.route.box = box;
  return record;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .png()
      .toBuffer(),
  );
}

/** A job as intake leaves it, queued with its screenshots stored. */
async function queuedJob(images: readonly Uint8Array[], pastedText = ""): Promise<string> {
  const metas: ImageMeta[] = [];
  for (const bytes of images) {
    const { width, height } = await sharp(bytes).metadata();
    metas.push({
      contentType: "image/png",
      bytes: bytes.length,
      width: width!,
      height: height!,
      sha256: sha256(bytes),
    });
  }
  const started = await startJob(
    { db, clock, storage },
    { images: metas, pastedText, clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  const { rows } = await db.query<{ storage_path: string }>(
    "select storage_path from {{schema}}.job_images where job_id = $1 order by position",
    [started.jobId],
  );
  for (const [i, row] of rows.entries()) {
    await storage.put(row.storage_path, images[i]!, "image/png");
  }
  if (images.length > 0) {
    const confirmed = await confirmUploads({ db, clock, storage }, started.jobId);
    if (!confirmed.ok) throw new Error(confirmed.reason);
  }
  return started.jobId;
}

async function run(id: string, gemini: "set" | "missing" = "set"): Promise<void> {
  const deps = { db, clock, pipeline: pipeline(gemini) };
  const lease = await claimJob(deps, id);
  if (!lease) throw new Error("not claimed");
  await runJob(deps, lease);
}

async function readOf(id: string): Promise<AddressReadOutput> {
  return (await stageOutput(db, id, "address_read"))!.output as AddressReadOutput;
}

async function loggedStages(id: string): Promise<string[]> {
  const { rows } = await db.query<{ stage: string }>(
    "select stage from {{schema}}.model_calls where job_id = $1 order by started_at",
    [id],
  );
  return rows.map((row) => row.stage);
}

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
  root = mkdtempSync(join(tmpdir(), "jobkit-address-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("address_read from a screenshot", () => {
  const box = { tile: 1, x1: 100, y1: 100, x2: 400, y2: 140 };

  it("reads the contact again from its crop alone, between markers, and keeps the crop", async () => {
    const id = await queuedJob([await png(800, 600)]);
    llm = fakeLlm([answer(withBox(box)), answer({ contact: "jobs@example.com" })]);

    await run(id);

    expect((await loadJob(db, id))?.state).toBe("kit_ready");
    const read = await readOf(id);
    expect(read).toMatchObject({
      checked: true,
      kind: "email",
      second: { read: "jobs@example.com" },
    });
    expect(agreement("email", "jobs@example.com", read.second)).toEqual({ ok: true });
    // The crop: the box with its margins, twofold, under the job's crops/ path.
    expect(read.cropPath).toMatch(new RegExp(`^jobs/${id}/crops/[0-9a-f]{64}\\.png$`));
    const stored = await storage.get(read.cropPath!);
    const size = await sharp(stored!).metadata();
    expect([size.width, size.height]).toEqual([
      (300 + 2 * CROP.margin) * CROP.scale,
      (40 + 2 * CROP.margin) * CROP.scale,
    ]);
    // The second model sees the crop and nothing of the post's words.
    const request = llm.calls[1]!;
    expect(request.model).toBe(ADDRESS_READ.model);
    expect(request.system).toBe(ADDRESS_READ_RULES);
    const marker = read.markers[0]!;
    expect(request.content.map((part) => part.type)).toEqual(["text", "image", "text", "text"]);
    expect(request.content[0]).toEqual({ type: "text", text: `BEGIN CROP ${marker}` });
    expect(request.content[2]).toEqual({ type: "text", text: `END CROP ${marker}` });
    expect(JSON.stringify(request.content)).not.toContain("Northwind");
    expect(await loggedStages(id)).toEqual(["extract", "address_read"]);
  });

  it("gives a read that differs, for the owner to settle", async () => {
    const id = await queuedJob([await png(800, 600)]);
    llm = fakeLlm([answer(withBox(box)), answer({ contact: "jobs@examp1e.com" })]);

    await run(id);

    expect(agreement("email", "jobs@example.com", (await readOf(id)).second)).toEqual({
      ok: false,
      reason: "disagree",
    });
  });

  it("leaves the read missing, never failing the job, when the model fails or no Gemini key is set", async () => {
    const failed = await queuedJob([await png(800, 600)]);
    llm = fakeLlm([answer(withBox(box)), failure("server"), failure("server")]);
    await run(failed);

    expect((await loadJob(db, failed))?.state).toBe("kit_ready");
    expect((await readOf(failed)).second).toEqual({ read: null });

    const noKey = await queuedJob([await png(800, 600)]);
    llm = fakeLlm([answer(withBox(box))]);
    await run(noKey, "missing");

    expect((await loadJob(db, noKey))?.state).toBe("kit_ready");
    const read = await readOf(noKey);
    expect(read.second).toEqual({ read: null });
    expect(await storage.get(read.cropPath!)).not.toBeNull();
    expect(llm.calls).toHaveLength(1);
  });

  it("has no crop to read for a box that does not fit its screenshot", async () => {
    const id = await queuedJob([await png(800, 600)]);
    llm = fakeLlm([answer(withBox({ tile: 1, x1: 700, y1: 100, x2: 900, y2: 140 }))]);

    await run(id);

    expect((await readOf(id)).second).toEqual({ problem: "invalid_box" });
    expect(await loggedStages(id)).toEqual(["extract"]);
  });

  it("has no crop when the screenshot is gone from storage", async () => {
    const image = await png(800, 600);
    const id = await queuedJob([image]);
    llm = fakeLlm([answer(withBox(box))]);
    const deps = { db, clock, pipeline: pipeline() };
    // Extract reads the screenshot; then it goes before the second read.
    const extracting = await claimJob(deps, id);
    const { rows } = await db.query<{ storage_path: string }>(
      "select storage_path from {{schema}}.job_images where job_id = $1",
      [id],
    );
    const removing: Pipeline = {
      ...deps.pipeline,
      eligibility: {
        ...passing({ state: "drafting", pending: "draft" }),
        run: async () => {
          rmSync(join(root, rows[0]!.storage_path));
          return { ok: true, output: {} };
        },
      },
    };
    await runJob({ ...deps, pipeline: removing }, extracting!);

    expect((await readOf(id)).second).toEqual({ problem: "no_crop" });
  });
});

describe("address_read from pasted text", () => {
  it("looks for the contact in the text, with no model", async () => {
    const found = await queuedJob([], "Northwind Analytics is hiring. Apply to jobs@example.com.");
    llm = fakeLlm([answer(fixture("S01-email-simple"))]);
    await run(found);

    expect((await readOf(found)).second).toEqual({ inText: true });
    expect(await loggedStages(found)).toEqual(["extract"]);

    const missing = await queuedJob([], "Northwind Analytics is hiring. Apply on our site.");
    llm = fakeLlm([answer(fixture("S01-email-simple"))]);
    await run(missing);

    expect(agreement("email", "jobs@example.com", (await readOf(missing)).second)).toEqual({
      ok: false,
      reason: "not_in_text",
    });
  });
});
