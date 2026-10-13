import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { answer, fakeLlm, type FakeLlm } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { draftStage } from "@/core/drafting/draftStage";
import type { BlockVerdict } from "@/core/drafting/judge";
import type { DraftAnswer } from "@/core/drafting/kit";
import { addressReadStage } from "@/core/extraction/addressReadStage";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { claimJob, type Pipeline, runJob } from "@/core/platform/runner";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import { addressChecksStage } from "./addressChecksStage";
import { jobView } from "./jobView";
import { recordReview } from "./kitReview";

/* The owner's decisions on a kit, kept with the gate they leave: review AC1 and AC4. */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;

const random = { bytes: (length: number) => new Uint8Array(length).fill(7) };

const models = (): ModelCallDeps => ({
  db,
  clock,
  llmFor: () => llm,
  guard: async () => ({ ok: true }),
});

const none = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };
const DRAFT: DraftAnswer = {
  fit: [
    { requirement_id: "R1", verdict: "met", fact_ids: ["F-react-production"], note: "" },
    { requirement_id: "R2", verdict: "met", fact_ids: ["F-node-apis"], note: "" },
    { requirement_id: "R3", verdict: "met", fact_ids: ["F-node-apis"], note: "" },
    { requirement_id: "R4", verdict: "gap", fact_ids: [], note: "" },
  ],
  blocks: [
    {
      id: "S1",
      text: "I have built production React applications for five years.",
      paragraph_break: true,
      class: "claim",
      fact_ids: ["F-react-production"],
      fields: [],
      gap: none,
    },
  ],
};

/** The judge, as a stage that gives these verdicts on the kit. */
const judging = (verdicts: BlockVerdict[]) => ({
  callsModel: false,
  input: () => ({}),
  run: async () => ({
    ok: true as const,
    output: { checked: true, verdicts, markers: [] },
  }),
  next: () => ({ state: "kit_ready" as const, pending: null }),
});

/** A job run to its kit, its post pasted with `text`, the judge calling S1 overstated. */
async function readyKit(text: string): Promise<string> {
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: text, clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  const record = JSON.parse(
    readFileSync(join(SYNTHETIC, "records", "S01-email-simple.json"), "utf8"),
  ) as JobRecord;
  llm = fakeLlm([answer(record), answer(DRAFT)]);
  const pipeline: Pipeline = {
    extract: extractStage({ db, storage, random, models: models() }),
    eligibility: eligibilityStage({ db, clock }),
    draft: {
      ...draftStage({ db, random, models: models() }),
      alongside: () => ["address_read", "address_checks"],
    },
    address_read: addressReadStage({ db, storage, random, models: models() }),
    address_checks: addressChecksStage({ db, dns: offlineDns() }),
    judge: judging([
      { blockId: "S1", verdict: "overstated", companyClaim: false, note: "Five years is more." },
    ]),
  };
  const deps = { db, clock, pipeline };
  const lease = await claimJob(deps, started.jobId);
  if (!lease) throw new Error("not claimed");
  await runJob(deps, lease);
  return started.jobId;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.kit_reviews; delete from {{schema}}.model_calls;
     delete from {{schema}}.job_stage_runs; delete from {{schema}}.job_leases;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs; delete from {{schema}}.profile_versions`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-review-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  await seedProfile({ db, storage, clock }, checked);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const kinds = (gate: readonly { kind: string }[]) => gate.map((reason) => reason.kind);

describe("recordReview", () => {
  it("keeps each decision with the gate it leaves, which the job page reads", async () => {
    // The post gives no address: the owner must type it.
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");

    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual(["contact", "judge"]);

    const checked = await recordReview({ db, clock }, id, { kind: "check", blockId: "S1" });
    expect(checked.ok && kinds(checked.gate)).toEqual(["contact"]);

    const typed = await recordReview({ db, clock }, id, {
      kind: "retype",
      value: "jobs@example.com",
    });
    expect(typed.ok && kinds(typed.gate)).toEqual([]);

    const view = (await jobView({ db, clock }, id))!;
    expect(view.review).toEqual({
      decisions: {
        checked: ["S1"],
        retyped: "jobs@example.com",
        attached: [],
        continueAnyway: false,
      },
      gate: typed.ok ? typed.gate : [],
    });
  });

  it("refuses a decision the kit has no place for", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    // The pasted post gives the address the record has: nothing to type.
    expect((await jobView({ db, clock }, id))!.kitParts!.contact).toEqual({
      kind: "email",
      needsRetype: false,
    });

    for (const action of [
      { kind: "check", blockId: "S9" },
      { kind: "attach", name: "Portfolio", ticked: true },
      { kind: "continue_anyway" },
      { kind: "retype", value: "other@example.com" },
    ] as const) {
      expect(await recordReview({ db, clock }, id, action), action.kind).toEqual({
        ok: false,
        reason: "not-in-kit",
      });
    }
  });

  it("refuses any decision before the kit is ready, and for a job that is not there", async () => {
    const started = await startJob(
      { db, clock, storage },
      { images: [], pastedText: "We're hiring.", clientElapsedMs: 0 },
    );
    if (!started.ok) throw new Error(started.message);

    expect(await recordReview({ db, clock }, started.jobId, { kind: "continue_anyway" })).toEqual({
      ok: false,
      reason: "not-ready",
    });
    expect(
      await recordReview({ db, clock }, "00000000-0000-4000-8000-000000000000", {
        kind: "continue_anyway",
      }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("keeps both of two decisions made at once", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");

    await Promise.all([
      recordReview({ db, clock }, id, { kind: "check", blockId: "S1" }),
      recordReview({ db, clock }, id, { kind: "retype", value: "jobs@example.com" }),
    ]);

    expect((await jobView({ db, clock }, id))!.review!.decisions).toMatchObject({
      checked: ["S1"],
      retyped: "jobs@example.com",
    });
  });
});
