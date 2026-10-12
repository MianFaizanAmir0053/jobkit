import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm, type FakeStep } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { draftStage } from "@/core/drafting/draftStage";
import { judgePassThrough } from "@/core/drafting/judgeStage";
import type { DraftAnswer } from "@/core/drafting/kit";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { issueSession } from "@/core/platform/sessions";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import { draftAnyway, readAgain, retry, role, sent, skip } from "./jobActions";
import { startPipeline } from "./jobs";

/* The job page's routes: Retry, Skip, the role pick, Read it again, Mark sent (B2, B9). */

const ORIGIN = "http://localhost:3000";
const SYNTHETIC = join(process.cwd(), "evals", "synthetic");
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;
let scheduled: (() => Promise<unknown>)[];

const random = { bytes: (length: number) => new Uint8Array(length).fill(3) };
const models = (): ModelCallDeps => ({
  db,
  clock,
  llmFor: () => llm,
  guard: async () => ({ ok: true }),
});

const deps = () => ({
  db,
  clock,
  config,
  pipeline: {
    extract: extractStage({ db, storage, random, models: models() }),
    eligibility: eligibilityStage({ db, clock }),
    draft: draftStage({ db, random, models: models() }),
    judge: judgePassThrough(),
  },
  schedule: (task: () => Promise<unknown>) => {
    scheduled.push(task);
  },
});

const fixture = (id: string): JobRecord =>
  JSON.parse(readFileSync(join(SYNTHETIC, "records", `${id}.json`), "utf8")) as JobRecord;

const none = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };
const DRAFT: DraftAnswer = {
  fit: [{ requirement_id: "R1", verdict: "met", fact_ids: ["F-react-production"], note: "" }],
  blocks: [
    {
      id: "S1",
      text: "I have built production React applications for five years.",
      paragraph_break: false,
      class: "claim",
      fact_ids: ["F-react-production"],
      fields: [],
      gap: none,
    },
  ],
};

async function seedSample(): Promise<void> {
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  await seedProfile({ db, storage, clock }, checked);
}

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

/** Runs what the routes scheduled, as after() would once the response has gone. */
async function drain(steps: readonly FakeStep[] = []): Promise<void> {
  llm = fakeLlm(steps);
  while (scheduled.length > 0) await scheduled.shift()!();
}

/** A paste-only job, run until it settles with the fake model's answers. */
async function settled(steps: readonly FakeStep[]): Promise<string> {
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: "A job post. Apply at jobs@example.com", clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  await startPipeline(deps(), started.jobId, clock.now());
  await drain(steps);
  return started.jobId;
}

const stateOf = async (id: string) => (await loadJob(db, id))?.state;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.status_changes; delete from {{schema}}.applications;
     delete from {{schema}}.sessions; delete from {{schema}}.model_calls;
     delete from {{schema}}.job_stage_runs; delete from {{schema}}.job_leases;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.jobs; delete from {{schema}}.profile_versions`,
  );
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-actions-"));
  storage = createLocalStorage({ root, origin: ORIGIN });
  scheduled = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the job page's routes", () => {
  it("retry a failed job at its stage and start it again", async () => {
    const cookie = await signedIn();
    // No profile yet: the draft fails.
    const id = await settled([answer(fixture("S01-email-simple"))]);
    expect(await stateOf(id)).toBe("failed");
    await seedSample();

    const response = await retry(post(`/api/jobs/${id}/retry`, "", cookie), deps(), id);

    expect(response.status).toBe(202);
    await drain([answer(DRAFT)]);
    expect(await stateOf(id)).toBe("kit_ready");
    expect((await retry(post(`/api/jobs/${id}/retry`, "", cookie), deps(), id)).status).toBe(409);
  });

  it("pick a role, start the chain with it, and refuse a role the post lacks", async () => {
    await seedSample();
    const cookie = await signedIn();
    const id = await settled([answer(fixture("S07-two-roles"))]);
    expect(await stateOf(id)).toBe("needs_role_pick");

    expect(
      (
        await role(
          post(`/api/jobs/${id}/role`, JSON.stringify({ roleId: "P9" }), cookie),
          deps(),
          id,
        )
      ).status,
    ).toBe(409);
    expect((await role(post(`/api/jobs/${id}/role`, "not json", cookie), deps(), id)).status).toBe(
      400,
    );

    const response = await role(
      post(`/api/jobs/${id}/role`, JSON.stringify({ roleId: "P2" }), cookie),
      deps(),
      id,
    );

    expect(response.status).toBe(202);
    await drain([answer(DRAFT)]);
    expect(await stateOf(id)).toBe("kit_ready");
  });

  it("skip at the role pick and at a stop, closing the job", async () => {
    const cookie = await signedIn();
    const picking = await settled([answer(fixture("S07-two-roles"))]);
    const stopped = await settled([answer(fixture("S08-urdu"))]);

    expect(
      (await skip(post(`/api/jobs/${picking}/skip`, "", cookie), deps(), picking)).status,
    ).toBe(200);
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, "", cookie), deps(), stopped)).status,
    ).toBe(200);
    expect([await stateOf(picking), await stateOf(stopped)]).toEqual(["closed", "closed"]);
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, "", cookie), deps(), stopped)).status,
    ).toBe(409);
  });

  it("read a post again after a no-role stop, once", async () => {
    const cookie = await signedIn();
    const id = await settled([answer({ ...fixture("S01-email-simple"), roles: [] })]);

    expect(
      (await readAgain(post(`/api/jobs/${id}/read-again`, "", cookie), deps(), id)).status,
    ).toBe(202);
    await drain([answer({ ...fixture("S01-email-simple"), roles: [] })]);

    expect(await stateOf(id)).toBe("stopped");
    expect(
      (await readAgain(post(`/api/jobs/${id}/read-again`, "", cookie), deps(), id)).status,
    ).toBe(409);
  });

  it("draft anyway for a role that looks closed, or skip it", async () => {
    await seedSample();
    const cookie = await signedIn();
    const closed = await settled([answer(fixture("S02-us-only"))]);
    const skipped = await settled([answer(fixture("S02-us-only"))]);
    expect([await stateOf(closed), await stateOf(skipped)]).toEqual([
      "needs_eligibility_decision",
      "needs_eligibility_decision",
    ]);

    const response = await draftAnyway(
      post(`/api/jobs/${closed}/draft-anyway`, "", cookie),
      deps(),
      closed,
    );
    expect(response.status).toBe(202);
    await drain([answer(DRAFT)]);
    expect(await stateOf(closed)).toBe("kit_ready");
    expect(
      (await draftAnyway(post(`/api/jobs/${closed}/draft-anyway`, "", cookie), deps(), closed))
        .status,
    ).toBe(409);

    expect(
      (await skip(post(`/api/jobs/${skipped}/skip`, "", cookie), deps(), skipped)).status,
    ).toBe(200);
    expect(await stateOf(skipped)).toBe("closed");
  });

  it("mark a ready kit sent, and refuse one that is not ready", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const picking = await settled([answer(fixture("S07-two-roles"))]);

    const response = await sent(post(`/api/jobs/${ready}/sent`, "", cookie), deps(), ready);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(
      (await sent(post(`/api/jobs/${picking}/sent`, "", cookie), deps(), picking)).status,
    ).toBe(409);
  });

  it("refuse another origin, a missing session and an unknown job", async () => {
    const cookie = await signedIn();
    const id = await settled([answer(fixture("S08-urdu"))]);
    const actions = [retry, skip, role, readAgain, draftAnyway, sent] as const;

    for (const action of actions) {
      expect(
        (await action(post(`/api/jobs/${id}/x`, "{}", cookie, "https://evil.example"), deps(), id))
          .status,
      ).toBe(403);
      expect((await action(post(`/api/jobs/${id}/x`, "{}"), deps(), id)).status).toBe(401);
      expect((await action(post("/api/jobs/x/x", "{}", cookie), deps(), "not-a-uuid")).status).toBe(
        404,
      );
    }
    expect(await stateOf(id)).toBe("stopped");
  });
});
