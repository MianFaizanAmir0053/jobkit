import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm, type FakeStep } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { draftStage } from "@/core/drafting/draftStage";
import { judgePassThrough } from "@/core/drafting/judgeStage";
import type { DraftAnswer } from "@/core/drafting/kit";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import { confirmPost } from "@/core/extraction/owner";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { claimJob, runJob } from "@/core/platform/runner";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import { jobView, listJobViews } from "./jobView";
import { markSent } from "./markSent";

/* What the job page and the jobs list read, and Mark sent, on the thin path. */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;

const random = { bytes: (length: number) => new Uint8Array(length).fill(7) };

function models(): ModelCallDeps {
  return { db, clock, llmFor: () => llm, guard: async () => ({ ok: true }) };
}

const pipeline = () => ({
  extract: extractStage({ db, storage, random, models: models() }),
  eligibility: eligibilityStage({ db, clock }),
  draft: draftStage({ db, random, models: models() }),
  judge: judgePassThrough(),
});

const fixture = (id: string): JobRecord =>
  JSON.parse(readFileSync(join(SYNTHETIC, "records", `${id}.json`), "utf8")) as JobRecord;

async function seedSample(): Promise<void> {
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  await seedProfile({ db, storage, clock }, checked);
}

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

async function run(id: string, steps: readonly FakeStep[]): Promise<void> {
  llm = fakeLlm(steps);
  const deps = { db, clock, pipeline: pipeline() };
  const lease = await claimJob(deps, id);
  if (!lease) throw new Error("not claimed");
  await runJob(deps, lease);
}

async function pasted(text = "We're hiring. Apply at jobs@example.com"): Promise<string> {
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: text, clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
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
    `delete from {{schema}}.status_changes; delete from {{schema}}.applications;
     delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-view-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("jobView", () => {
  it("shows a ready kit with its steps, the judge marked not checked", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);

    const view = (await jobView({ db, clock }, id))!;

    expect(view).toMatchObject({
      state: "kit_ready",
      kind: "ready",
      failure: null,
      application: null,
    });
    expect(view.steps.map(({ label, status }) => [label, status])).toEqual([
      ["Read the post", "done"],
      ["Check eligibility", "done"],
      ["Write the email", "done"],
      ["Check every sentence separately", "not_checked"],
    ]);
    expect(view.role?.id).toBe("P1");
    expect(view.draft?.kit.subject).toBe("Application - Senior Full-Stack Engineer - Sam Rivera");
  });

  it("says why a job stopped and whether it can be read again", async () => {
    const id = await pasted();
    await run(id, [answer({ ...fixture("S01-email-simple"), roles: [] })]);

    expect(await jobView({ db, clock }, id)).toMatchObject({
      state: "stopped",
      stopReason: "no_role",
      canReadAgain: true,
    });

    const urdu = await pasted("ہمیں ایک ویب ڈویلپر کی ضرورت ہے");
    await run(urdu, [answer(fixture("S08-urdu"))]);
    expect(await jobView({ db, clock }, urdu)).toMatchObject({
      stopReason: "language",
      canReadAgain: false,
    });
  });

  it("shows a failure's reason, and its recorded cause apart from it", async () => {
    // No profile: eligibility fails with words the page shows.
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple"))]);

    const view = (await jobView({ db, clock }, id))!;

    expect(view.state).toBe("failed");
    expect(view.failure).toEqual({
      stage: "eligibility",
      reason:
        "There is no profile yet. Seed it on the laptop with npm run profile:seed, then press Retry.",
      detail: null,
    });
    expect(view.steps.find((step) => step.stage === "eligibility")?.status).toBe("failed");
  });

  it("applies the upload timeout when it reads a job", async () => {
    const started = await startJob(
      { db, clock, storage },
      {
        images: [
          {
            contentType: "image/png",
            bytes: 10,
            width: 1080,
            height: 2400,
            sha256: "a".repeat(64),
          },
        ],
        pastedText: "",
        clientElapsedMs: 0,
      },
    );
    if (!started.ok) throw new Error(started.message);
    clock.advance(15 * 60_000 + 1);

    expect((await jobView({ db, clock }, started.jobId))?.state).toBe("upload_failed");
  });

  it("shows a step running again as running, not as the result it gave before", async () => {
    const id = await pasted();
    await run(id, [answer({ ...fixture("S01-email-simple"), roles: [] })]);
    expect(await confirmPost({ db, clock }, id)).toEqual({ ok: true });

    const view = (await jobView({ db, clock }, id))!;

    expect(view.steps.find((step) => step.stage === "extract")?.status).toBe("running");
  });

  it("is null for a job that does not exist", async () => {
    expect(await jobView({ db, clock }, "33333333-3333-4333-8333-333333333333")).toBeNull();
    expect(await jobView({ db, clock }, "not-a-uuid")).toBeNull();
  });
});

describe("markSent", () => {
  it("records the application as sent once, with the role's address and the email route", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);

    expect(await markSent({ db, clock }, id, null, { changedInGmail: true })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toEqual({
      ok: true,
      changed: false,
    });

    const { rows } = await db.query<{
      status: string;
      route: string;
      address: string;
      role_id: string;
    }>("select status, route, address, role_id from {{schema}}.applications where job_id = $1", [
      id,
    ]);
    expect(rows).toEqual([
      { status: "sent", route: "email", address: "jobs@example.com", role_id: "P1" },
    ]);
    expect((await jobView({ db, clock }, id))?.application).toEqual({
      status: "sent",
      sentAt: clock.now(),
    });
    // The Gmail answer is the outcome's, once: a "Yes" is a factual edit (ledger spec).
    const outcomes = await db.query<{
      kind: string;
      changed_in_gmail: boolean;
      factual_edit: boolean;
    }>(
      "select kind, changed_in_gmail, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(outcomes.rows).toEqual([{ kind: "email", changed_in_gmail: true, factual_edit: true }]);
  });

  it("refuses a kit whose role is to be applied for another way", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S05-whatsapp-local-number")), answer(DRAFT)]);
    expect((await jobView({ db, clock }, id))?.state).toBe("kit_ready");

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toEqual({
      ok: false,
      reason: "not-email",
    });
  });

  it("refuses a job whose kit is not ready, and one that does not exist", async () => {
    const id = await pasted();
    await run(id, [answer({ ...fixture("S01-email-simple"), roles: [] })]);

    const answerNo = { changedInGmail: false };
    expect(await markSent({ db, clock }, id, null, answerNo)).toEqual({
      ok: false,
      reason: "not-ready",
    });
    expect(
      await markSent({ db, clock }, "33333333-3333-4333-8333-333333333333", null, answerNo),
    ).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("listJobViews", () => {
  it("lists jobs newest first, with what extract read of each", async () => {
    const older = await pasted();
    await run(older, [answer(fixture("S07-two-roles"))]);
    clock.advance(60_000);
    const newer = await pasted();
    await run(newer, [answer(fixture("S01-email-simple"))]);

    const list = await listJobViews({ db, clock });

    expect(list.map(({ id, state, company, title }) => ({ id, state, company, title }))).toEqual([
      {
        id: newer,
        state: "failed",
        company: "Northwind Analytics",
        title: "Senior Full-Stack Engineer",
      },
      {
        id: older,
        state: "needs_role_pick",
        company: fixture("S07-two-roles").company.name,
        title: "2 roles",
      },
    ]);
  });
  it("shows a sent kit as sent, and a long-dead upload as failed", async () => {
    await seedSample();
    const sentJob = await pasted();
    await run(sentJob, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await markSent({ db, clock }, sentJob, null, { changedInGmail: false });
    const started = await startJob(
      { db, clock, storage },
      {
        images: [
          {
            contentType: "image/png",
            bytes: 10,
            width: 1080,
            height: 2400,
            sha256: "a".repeat(64),
          },
        ],
        pastedText: "",
        clientElapsedMs: 0,
      },
    );
    if (!started.ok) throw new Error(started.message);
    clock.advance(15 * 60_000 + 1);

    const list = await listJobViews({ db, clock });

    expect(list.find((job) => job.id === sentJob)?.sent).toBe(true);
    expect(list.find((job) => job.id === started.jobId)).toMatchObject({
      state: "upload_failed",
      sent: false,
    });
  });
});
