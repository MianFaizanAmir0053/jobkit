import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm, type FakeStep } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { draftStage } from "@/core/drafting/draftStage";
import type { DraftAnswer } from "@/core/drafting/kit";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import { pickRole } from "@/core/extraction/owner";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import { changeStatus, openApplication } from "@/core/ledger/statuses";
import type { ModelCallDeps } from "@/core/platform/models";
import { claimJob, type Pipeline, runJob } from "@/core/platform/runner";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb, insertTestJobs } from "@/server/db/testDb";

import { openForJob, skippedForJob, trackApplications } from "./applications";
import { jobView } from "./jobView";
import { applyAgainForJob, recordReview } from "./kitReview";
import { markSent } from "./markSent";

/* The application's statuses as the job moves (ledger spec, "Statuses"), and duplicates in the gate. */

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
const fixture = (id: string): JobRecord =>
  JSON.parse(readFileSync(join(SYNTHETIC, "records", `${id}.json`), "utf8")) as JobRecord;

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
      text: "I have built production APIs in Node.js.",
      paragraph_break: true,
      class: "claim",
      fact_ids: ["F-node-apis"],
      fields: [],
      gap: none,
    },
  ],
};

/** The app's stages, the judge passing every kit, with the application's statuses kept. */
const pipeline = (): Pipeline =>
  trackApplications(
    {
      extract: extractStage({ db, storage, random, models: models() }),
      eligibility: eligibilityStage({ db, clock }),
      draft: draftStage({ db, random, models: models() }),
      judge: {
        callsModel: false,
        input: () => ({}),
        run: async () => ({
          ok: true as const,
          output: { checked: true, verdicts: [], markers: [] },
        }),
        next: () => ({ state: "kit_ready" as const, pending: null }),
      },
    },
    { db, clock },
  );

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

/** The address or number the ledger keeps on the job's application. */
async function addressOf(jobId: string): Promise<string | null | undefined> {
  const { rows } = await db.query<{ address: string | null }>(
    "select address from {{schema}}.applications where job_id = $1",
    [jobId],
  );
  return rows[0]?.address;
}

/** An earlier application, already sent, to Globex's designer role at hr@example.org. */
async function sentToGlobex(): Promise<void> {
  const earlier = "22222222-2222-4222-8222-222222222222";
  await insertTestJobs(db, [earlier]);
  const sent = await openApplication(
    { db, clock },
    {
      jobId: earlier,
      roleId: "P1",
      company: "Globex",
      role: "Designer",
      address: "hr@example.org",
      route: "email",
      requirements: [],
      arm: null,
      jobKind: "real",
    },
    null,
  );
  await changeStatus({ db, clock }, sent, "kit_ready", null);
  await changeStatus({ db, clock }, sent, "sent", null);
}

/** The job's application's status changes, as "from>to", sorted: the fake clock gives them one time. */
async function statusesOf(jobId: string): Promise<string[]> {
  const { rows } = await db.query<{ from_status: string | null; to_status: string }>(
    `select c.from_status, c.to_status from {{schema}}.status_changes as c
       join {{schema}}.applications as a on a.id = c.application_id
      where a.job_id = $1`,
    [jobId],
  );
  return rows.map((row) => `${row.from_status ?? "none"}>${row.to_status}`).sort();
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.kit_reviews; delete from {{schema}}.status_changes;
     delete from {{schema}}.draft_outcomes; delete from {{schema}}.applications;
     delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-applications-"));
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

describe("the application", () => {
  it("opens when the post's one role is chosen with it, and is kit_ready with the job", async () => {
    const id = await pasted();

    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);

    expect(await statusesOf(id)).toEqual(["none>open", "open>kit_ready"]);
  });

  it("opens when the owner picks one of several roles, and not before", async () => {
    const id = await pasted("Two roles. Apply at backend@example.com or ml@example.com");
    await run(id, [answer(fixture("S07-two-roles"))]);
    expect(await statusesOf(id)).toEqual([]);

    expect((await pickRole({ db, clock }, id, "P2")).ok).toBe(true);
    await openForJob({ db, clock }, id, null);

    expect(await statusesOf(id)).toEqual(["none>open"]);
  });

  it("keeps a WhatsApp number as its address, so a later post giving it matches", async () => {
    const id = await pasted("Next.js developer wanted. WhatsApp 0300 0000000");

    await run(id, [answer(fixture("S05-whatsapp-local-number"))]);

    expect(await addressOf(id)).toBe("0300 0000000");
  });

  it("takes the address the owner typed, which can find matches of its own", async () => {
    await sentToGlobex();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    expect(await addressOf(id)).toBe("jobs@example.com");

    // A typed address that fails the strict check changes nothing in the ledger.
    await recordReview({ db, clock }, id, { kind: "retype", value: "hr@example" });
    expect(await addressOf(id)).toBe("jobs@example.com");

    const typed = await recordReview({ db, clock }, id, {
      kind: "retype",
      value: "hr@example.org",
    });

    expect(await addressOf(id)).toBe("hr@example.org");
    expect(typed.ok && typed.gate.map((reason) => reason.kind)).toEqual(["duplicate"]);
    expect((await jobView({ db, clock }, id))!.duplicates).toEqual([
      expect.objectContaining({ reason: "address", company: "Globex", covered: false }),
    ]);
  });

  it("keeps the address the owner typed when the kit is marked sent", async () => {
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await recordReview({ db, clock }, id, { kind: "retype", value: "hr@example.org" });

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });

    expect(await addressOf(id)).toBe("hr@example.org");
  });

  it("is skipped when the owner skips, before the kit or after it", async () => {
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);

    await skippedForJob({ db, clock }, id, null);

    expect(await statusesOf(id)).toEqual(["kit_ready>skipped", "none>open", "open>kit_ready"]);
  });
});

describe("duplicates in the gate", () => {
  it("hold a kit back until Apply again covers the matches shown", async () => {
    // An earlier application to the same company and role, already sent.
    const earlier = "11111111-1111-4111-8111-111111111111";
    await insertTestJobs(db, [earlier]);
    const record = fixture("S01-email-simple");
    const sent = await openApplication(
      { db, clock },
      {
        jobId: earlier,
        roleId: "P1",
        company: record.company.name,
        role: record.roles[0]!.title,
        address: null,
        route: "email",
        requirements: [],
        arm: null,
        jobKind: "real",
      },
      null,
    );
    await changeStatus({ db, clock }, sent, "kit_ready", null);
    await changeStatus({ db, clock }, sent, "sent", null);
    const id = await pasted();
    await run(id, [answer(record), answer(DRAFT)]);

    const held = (await jobView({ db, clock }, id))!;
    // This pipeline has no second read, so the contact holds the kit back too.
    expect(held.review!.gate.map((reason) => reason.kind)).toEqual(["duplicate", "contact"]);
    // The banner gives the day in the owner's time zone; the gate names the application only.
    expect(held.review!.gate[0]!.message).toBe(
      `You may have applied before: the same company and role as ${record.company.name}, ${record.roles[0]!.title}. Choose "Apply again" to go on.`,
    );
    expect(held.duplicates).toEqual([
      expect.objectContaining({
        reason: "company-role",
        company: record.company.name,
        covered: false,
      }),
    ]);

    const applied = await applyAgainForJob(
      { db, clock },
      id,
      held.duplicates.map((match) => match.key),
    );

    expect(applied.ok && applied.gate.map((reason) => reason.kind)).toEqual(["contact"]);
    expect((await jobView({ db, clock }, id))!.duplicates[0]!.covered).toBe(true);
  });
});
