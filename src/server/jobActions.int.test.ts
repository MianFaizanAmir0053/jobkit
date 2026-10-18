import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { answer, fakeLlm, type FakeLlm, type FakeStep, refusal } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { draftStage } from "@/core/drafting/draftStage";
import type { DraftAnswer } from "@/core/drafting/kit";
import { passingJudge } from "@/core/drafting/testJudge";
import { templatesStage } from "@/core/drafting/templatesStage";
import { noTemplateDrafts } from "@/core/drafting/testTemplates";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import { changeStatus, openApplication, undoStatus } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import { issueSession } from "@/core/platform/sessions";
import type { Db, QueryResult, Row } from "@/core/ports";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { openForJob } from "@/core/review/applications";
import { flagKey } from "@/core/review/decisions";
import { jobView } from "@/core/review/jobView";
import { recordReview } from "@/core/review/kitReview";
import type { AppConfig } from "@/server/config";
import { createTestDb, insertTestJobs } from "@/server/db/testDb";

import {
  applyAgainRoute,
  backToDrafts,
  bounced,
  images,
  submitted,
  draftAnyway,
  gate,
  geminiDraft,
  handoff,
  keepForEval,
  pick,
  readAgain,
  retry,
  review,
  role,
  sent,
  skip,
  takeBack,
} from "./jobActions";
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

/** The routes' ports; with `templates`, the sample profile's templates draft what they fit. */
const deps = (templates = false) => ({
  db,
  clock,
  dns: offlineDns(),
  config,
  pipeline: {
    extract: extractStage({ db, storage, random, models: models() }),
    eligibility: eligibilityStage({ db, clock }),
    templates: templates ? templatesStage({ db }) : noTemplateDrafts(),
    draft: draftStage({ db, random, models: models() }),
    // The judge has its own tests; here it finds every sentence supported.
    judge: passingJudge(),
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

/**
 * The owner clears what holds a kit through the review route, as on the
 * page: the address or number no second read confirmed, typed as the post
 * gives it, and each flag and sentence checked.
 */
async function clearedOnPage(
  id: string,
  cookie: string,
  typed = "jobs@example.com",
): Promise<void> {
  const view = (await jobView({ db, clock }, id))!;
  const actions: object[] = [];
  if (view.kitParts?.contact?.needsRetype) {
    actions.push({ kind: "retype", value: typed });
  }
  for (const flag of view.kitParts?.flags ?? []) {
    actions.push({ kind: "check_flag", flag: flagKey(flag) });
  }
  for (const reason of view.review?.gate ?? []) {
    if (reason.kind === "judge") actions.push({ kind: "check", blockId: reason.blockId });
  }
  for (const action of actions) {
    const body = JSON.stringify({ action, kit: view.kitKey, words: view.wordsKey });
    await review(post(`/api/jobs/${id}/review`, body, cookie), deps(), id);
  }
}

/** The kit as the job page shows it, which every decision names. */
const kitOf = async (id: string) => (await jobView({ db, clock }, id))!.kitKey!;
/** The words the page shows, which each of its decisions names. */
const wordsOf = async (id: string) => (await jobView({ db, clock }, id))!.wordsKey!;

function get(path: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, { headers });
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
async function settled(steps: readonly FakeStep[], templates = false): Promise<string> {
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: "A job post. Apply at jobs@example.com", clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  await startPipeline(deps(templates), started.jobId, clock.now());
  await drain(steps);
  return started.jobId;
}

const stateOf = async (id: string) => (await loadJob(db, id))?.state;

/**
 * The Skip of a page waiting on the owner, as it shows the job now: its
 * state, when it reached it, and the send the page warned may have gone.
 */
async function closing(id: string, uncertain: string | null = null): Promise<string> {
  const job = (await loadJob(db, id))!;
  return JSON.stringify({ state: job.state, since: job.stateChangedAt.toISOString(), uncertain });
}

/** The database, failing every write into this table, as on a dropped connection. */
const failingOn = (inner: Db, table: string): Db => ({
  schema: inner.schema,
  query: <T extends Row = Row>(sql: string, params?: readonly unknown[]) =>
    sql.includes(`into {{schema}}.${table}`)
      ? Promise.reject<QueryResult<T>>(new Error("connection lost"))
      : inner.query<T>(sql, params),
  exec: (sql) => inner.exec(sql),
  tx: (fn) => inner.tx((tx) => fn(failingOn(tx, table))),
});

/** An application sent before, to this company and role. */
async function sentEarlier(company: string, title: string): Promise<string> {
  const earlier = "44444444-4444-4444-8444-444444444444";
  await insertTestJobs(db, [earlier]);
  const id = await openApplication(
    { db, clock },
    {
      jobId: earlier,
      roleId: "P1",
      company,
      role: title,
      address: null,
      route: "email",
      requirements: [],
      arm: null,
      jobKind: "real",
    },
    null,
  );
  await changeStatus({ db, clock }, id, "kit_ready", null);
  await changeStatus({ db, clock }, id, "sent", null);
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.kit_reviews; delete from {{schema}}.kit_sends;
     delete from {{schema}}.status_changes;
     delete from {{schema}}.applications; delete from {{schema}}.sessions; delete from {{schema}}.model_calls;
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
      (
        await skip(
          post(`/api/jobs/${picking}/skip`, await closing(picking), cookie),
          deps(),
          picking,
        )
      ).status,
    ).toBe(200);
    const shown = await closing(stopped);
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, shown, cookie), deps(), stopped)).status,
    ).toBe(200);
    expect([await stateOf(picking), await stateOf(stopped)]).toEqual(["closed", "closed"]);
    // A second tap from the page that showed it stopped.
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, shown, cookie), deps(), stopped)).status,
    ).toBe(409);
  });

  it("skip an upload that ran out of time though nothing read it since, as the page showed it failed", async () => {
    const cookie = await signedIn();
    const started = await startJob(
      { db, clock, storage },
      {
        images: [
          {
            contentType: "image/webp",
            bytes: 1_000,
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
    const began = (await loadJob(db, started.jobId))!.stateChangedAt;
    clock.advance(15 * 60_000 + 1);
    // The page showed it failed as of its deadline; the database has not been told yet.
    const shown = JSON.stringify({
      state: "upload_failed",
      since: new Date(began.getTime() + 15 * 60_000).toISOString(),
      uncertain: null,
    });

    expect(
      (await skip(post(`/api/jobs/${started.jobId}/skip`, shown, cookie), deps(), started.jobId))
        .status,
    ).toBe(200);
    expect(await stateOf(started.jobId)).toBe("closed");
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
      (
        await skip(
          post(`/api/jobs/${skipped}/skip`, await closing(skipped), cookie),
          deps(),
          skipped,
        )
      ).status,
    ).toBe(200);
    expect(await stateOf(skipped)).toBe("closed");
  });

  it("mark a ready kit sent, and refuse one that is not ready", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const picking = await settled([answer(fixture("S07-two-roles"))]);

    const kit = await kitOf(ready);
    const no = JSON.stringify({ changedInGmail: false, kit, to: "jobs@example.com" });
    for (const body of ["{}", JSON.stringify({ changedInGmail: false })]) {
      expect(
        (await sent(post(`/api/jobs/${ready}/sent`, body, cookie), deps(), ready)).status,
      ).toBe(400);
    }
    // Held: no second read confirmed the address.
    expect((await sent(post(`/api/jobs/${ready}/sent`, no, cookie), deps(), ready)).status).toBe(
      409,
    );
    await clearedOnPage(ready, cookie);
    // A page showing another address than the one the kit now goes to.
    const elsewhere = JSON.stringify({ changedInGmail: false, kit, to: "other@example.com" });
    expect(
      (await sent(post(`/api/jobs/${ready}/sent`, elsewhere, cookie), deps(), ready)).status,
    ).toBe(409);
    const response = await sent(post(`/api/jobs/${ready}/sent`, no, cookie), deps(), ready);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(
      (await sent(post(`/api/jobs/${picking}/sent`, no, cookie), deps(), picking)).status,
    ).toBe(409);
    // A mistaken tap is taken back, by the Mark sent the page showed, and the kit opens again.
    const shown = (await jobView({ db, clock }, ready))!.application!.sentAt!.toISOString();
    expect(
      (await takeBack(post(`/api/jobs/${ready}/take-back`, "", cookie), deps(), ready)).status,
    ).toBe(400);
    expect(
      (
        await takeBack(
          post(`/api/jobs/${ready}/take-back`, JSON.stringify({ sentAt: shown }), cookie),
          deps(),
          ready,
        )
      ).status,
    ).toBe(200);
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("kit_ready");
  });

  it("read the gate as it stands, for a page drawn before it changed", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);

    const held = await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready);
    expect(await held.json()).toEqual({
      kit: await kitOf(ready),
      open: false,
      to: "",
      status: null,
      words: expect.any(String),
    });
    await clearedOnPage(ready, cookie);

    // With the address the kit goes to, so a page showing another learns of it.
    const open = await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready);
    expect(await open.json()).toEqual({
      kit: await kitOf(ready),
      open: true,
      to: "jobs@example.com",
      status: null,
      words: expect.any(String),
    });
    expect((await gate(get(`/api/jobs/${ready}/gate`), deps(), ready)).status).toBe(401);
  });

  it("record a decision on a ready kit, and refuse one the kit has no place for", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const kit = await kitOf(ready);
    const words = await wordsOf(ready);
    const typed = JSON.stringify({
      action: { kind: "retype", value: "jobs@example.com" },
      kit,
      words,
    });

    const response = await review(post(`/api/jobs/${ready}/review`, typed, cookie), deps(), ready);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ gate: expect.any(Array) });
    // A page drawn on another kit: the owner must look again.
    const stale = JSON.stringify({
      action: { kind: "check", blockId: "S1" },
      kit: "another kit",
      words,
    });
    expect(
      (await review(post(`/api/jobs/${ready}/review`, stale, cookie), deps(), ready)).status,
    ).toBe(409);
    const nowhere = JSON.stringify({ action: { kind: "check", blockId: "S9" }, kit, words });
    expect(
      (await review(post(`/api/jobs/${ready}/review`, nowhere, cookie), deps(), ready)).status,
    ).toBe(409);
    // A page drawn before flags were named posts a flag's place: drawn again, as for a stale page.
    const placed = JSON.stringify({ action: { kind: "check_flag", flag: "F1" }, kit, words });
    const old = await review(post(`/api/jobs/${ready}/review`, placed, cookie), deps(), ready);
    expect(old.status).toBe(409);
    // A page from before decisions named the words it showed: drawn again.
    const wordless = JSON.stringify({ action: { kind: "check", blockId: "S1" }, kit });
    expect(
      (await review(post(`/api/jobs/${ready}/review`, wordless, cookie), deps(), ready)).status,
    ).toBe(409);
    expect(
      (
        await review(
          post(`/api/jobs/${ready}/review`, '{"action":{"kind":"send"}}', cookie),
          deps(),
          ready,
        )
      ).status,
    ).toBe(400);
    expect((await review(post(`/api/jobs/${ready}/review`, typed), deps(), ready)).status).toBe(
      401,
    );
  });

  it("skip closes the job and skips its application in one step, so a failed skip can be tried again", async () => {
    await seedSample();
    const cookie = await signedIn();
    const id = await settled([answer(fixture("S02-us-only"))]);
    await openForJob({ db, clock }, id, null);
    const failing = { ...deps(), db: failingOn(db, "status_changes") };

    await expect(
      skip(post(`/api/jobs/${id}/skip`, await closing(id), cookie), failing, id),
    ).rejects.toThrow("connection lost");
    expect(await stateOf(id)).toBe("needs_eligibility_decision");

    expect(
      (await skip(post(`/api/jobs/${id}/skip`, await closing(id), cookie), deps(), id)).status,
    ).toBe(200);
    expect(await stateOf(id)).toBe("closed");
    const { rows } = await db.query<{ status: string }>(
      "select status from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows.map((row) => row.status)).toEqual(["skipped"]);
  });

  it("skip a ready kit's application, the job staying ready, and take back the skip the page showed", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const shown = JSON.stringify({ kit: await kitOf(ready), uncertain: null });

    const response = await skip(post(`/api/jobs/${ready}/skip`, shown, cookie), deps(), ready);

    expect(response.status).toBe(200);
    expect(await stateOf(ready)).toBe("kit_ready");
    const view = (await jobView({ db, clock }, ready))!;
    expect(view.application?.status).toBe("skipped");
    expect(view.review?.gate.map((reason) => reason.kind)).toEqual(["skipped"]);
    // A page drawn before the skip, on another device or in another tab, learns of it.
    const answered = await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready);
    expect(await answered.json()).toMatchObject({ open: false, status: "skipped" });
    // Taken back by the skip the page showed; a body naming none is refused.
    const skippedAt = view.application!.skippedAt!.toISOString();
    expect(
      (await takeBack(post(`/api/jobs/${ready}/take-back`, "{}", cookie), deps(), ready)).status,
    ).toBe(400);
    const taken = await takeBack(
      post(`/api/jobs/${ready}/take-back`, JSON.stringify({ skippedAt }), cookie),
      deps(),
      ready,
    );
    expect(taken.status).toBe(200);
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("kit_ready");
    // The other device's page learns of that too.
    const reopened = await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready);
    expect(await reopened.json()).toMatchObject({ status: "kit_ready" });
    // A late tap from a page that showed that skip changes nothing.
    const late = await takeBack(
      post(`/api/jobs/${ready}/take-back`, JSON.stringify({ skippedAt }), cookie),
      deps(),
      ready,
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "not-skipped" });
  });

  it("refuse a Skip the job moved on from: a kit's never closes a job, and a closing one never skips a kit", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const stopped = await settled([answer({ ...fixture("S01-email-simple"), roles: [] })]);
    const kitSkip = JSON.stringify({ kit: await kitOf(ready), uncertain: null });

    // A kit's Skip from a page drawn before the job stopped, as after a failed redraft.
    const late = await skip(post(`/api/jobs/${stopped}/skip`, kitSkip, cookie), deps(), stopped);
    expect(late.status).toBe(409);
    expect(await stateOf(stopped)).toBe("stopped");
    // A stopped page's Skip, arriving after the job moved on to a ready kit, or showing none.
    const stale = await closing(stopped);
    expect((await skip(post(`/api/jobs/${ready}/skip`, stale, cookie), deps(), ready)).status).toBe(
      409,
    );
    expect((await skip(post(`/api/jobs/${ready}/skip`, "", cookie), deps(), ready)).status).toBe(
      409,
    );
    expect((await jobView({ db, clock }, ready))!.application?.status ?? null).not.toBe("skipped");
    // A page that says nothing of what it showed, from before Skip said so, is drawn again.
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, "", cookie), deps(), stopped)).status,
    ).toBe(409);
    expect(await stateOf(stopped)).toBe("stopped");
    // A Skip that names no send, a state that is none, or no kit, is not read.
    for (const body of [
      JSON.stringify({ state: "stopped" }),
      JSON.stringify({ state: "stopped", uncertain: null }),
      JSON.stringify({ state: "nonsense", uncertain: null }),
      JSON.stringify({ kit: "", uncertain: null }),
      JSON.stringify({ kit: "K", uncertain: "not-a-send" }),
    ]) {
      expect(
        (await skip(post(`/api/jobs/${stopped}/skip`, body, cookie), deps(), stopped)).status,
      ).toBe(400);
    }
    // A Skip naming the job's state but an earlier time in it, as from a page drawn before a
    // retry that stopped again: the page is stale.
    const earlier = JSON.stringify({
      state: "stopped",
      since: new Date(0).toISOString(),
      uncertain: null,
    });
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, earlier, cookie), deps(), stopped)).status,
    ).toBe(409);
    expect(await stateOf(stopped)).toBe("stopped");
    // The stopped page's own Skip closes its job, as before.
    expect(
      (await skip(post(`/api/jobs/${stopped}/skip`, stale, cookie), deps(), stopped)).status,
    ).toBe(200);
    expect(await stateOf(stopped)).toBe("closed");
  });

  it("skip past a send that may have gone only from a page that warned of it, on a ready kit or a failed job", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const kit = await kitOf(ready);
    const { rows } = await db.query<{ id: string }>(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, created_at, updated_at)
       values ($1, 'P1', $2, 'jobs@example.com', 'unknown', $3, $3, $3)
       returning id`,
      [ready, kit, clock.now()],
    );
    const stuck = rows[0]!.id;

    const unwarned = await skip(
      post(`/api/jobs/${ready}/skip`, JSON.stringify({ kit, uncertain: null }), cookie),
      deps(),
      ready,
    );
    expect(unwarned.status).toBe(409);
    expect(await unwarned.json()).toEqual({ error: "uncertain" });
    // As when a Gemini draft asked for beside the kit failed: the failed page's Skip closes the job.
    await db.query(
      "update {{schema}}.jobs set state = 'failed', pending_stage = 'draft', failed_stage = 'draft' where id = $1",
      [ready],
    );
    const closingUnwarned = await skip(
      post(`/api/jobs/${ready}/skip`, await closing(ready), cookie),
      deps(),
      ready,
    );
    expect(closingUnwarned.status).toBe(409);
    expect(await closingUnwarned.json()).toEqual({ error: "uncertain" });
    expect(await stateOf(ready)).toBe("failed");
    expect(
      (
        await skip(
          post(`/api/jobs/${ready}/skip`, await closing(ready, stuck), cookie),
          deps(),
          ready,
        )
      ).status,
    ).toBe(200);
    expect(await stateOf(ready)).toBe("closed");
  });

  it("skip a ready kit in one step, so a skip cut short leaves it ready and can be tried again", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    // Its application kit_ready with the kit, as the app's pipeline keeps it.
    const applicationId = (await openForJob({ db, clock }, ready, null))!;
    await changeStatus({ db, clock }, applicationId, "kit_ready", null);
    const shown = JSON.stringify({ kit: await kitOf(ready), uncertain: null });
    const failing = { ...deps(), db: failingOn(db, "status_changes") };

    await expect(
      skip(post(`/api/jobs/${ready}/skip`, shown, cookie), failing, ready),
    ).rejects.toThrow("connection lost");
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("kit_ready");

    expect((await skip(post(`/api/jobs/${ready}/skip`, shown, cookie), deps(), ready)).status).toBe(
      200,
    );
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("skipped");
  });

  it("mark a sent email bounced by the Mark sent the page showed, and take the bounce back", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await clearedOnPage(ready, cookie);
    const marked = JSON.stringify({
      changedInGmail: false,
      kit: await kitOf(ready),
      to: "jobs@example.com",
    });
    expect(
      (await sent(post(`/api/jobs/${ready}/sent`, marked, cookie), deps(), ready)).status,
    ).toBe(200);
    const sentAt = (await jobView({ db, clock }, ready))!.application!.sentAt!.toISOString();
    clock.advance(60_000);

    for (const body of ["", "{}", JSON.stringify({ sentAt: "yesterday" })]) {
      expect(
        (await bounced(post(`/api/jobs/${ready}/bounced`, body, cookie), deps(), ready)).status,
      ).toBe(400);
    }
    const response = await bounced(
      post(`/api/jobs/${ready}/bounced`, JSON.stringify({ sentAt }), cookie),
      deps(),
      ready,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    const view = (await jobView({ db, clock }, ready))!;
    expect(view.application?.status).toBe("bounced");
    // The other device's page learns of it at its next gate check.
    const answered = await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready);
    expect(await answered.json()).toMatchObject({ open: false, status: "bounced" });
    // A page that showed another Mark sent is refused.
    const stale = await bounced(
      post(
        `/api/jobs/${ready}/bounced`,
        JSON.stringify({ sentAt: new Date(0).toISOString() }),
        cookie,
      ),
      deps(),
      ready,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "changed" });
    // Taken back by the bounce the page showed.
    const bouncedAt = view.application!.bouncedAt!.toISOString();
    const taken = await takeBack(
      post(`/api/jobs/${ready}/take-back`, JSON.stringify({ bouncedAt }), cookie),
      deps(),
      ready,
    );
    expect(taken.status).toBe(200);
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("sent");
  });

  it("signs the post's images afresh for a page whose image did not load", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const withStorage = { ...deps(), storage };

    const response = await images(get(`/api/jobs/${ready}/images`, cookie), withStorage, ready);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    // A kit of pasted text alone, whose read never ran: no crop, no screenshot.
    expect(await response.json()).toEqual({ crop: null, screenshots: [] });

    expect((await images(get(`/api/jobs/${ready}/images`), withStorage, ready)).status).toBe(401);
    const missing = "33333333-3333-4333-8333-333333333333";
    expect(
      (await images(get(`/api/jobs/${missing}/images`, cookie), withStorage, missing)).status,
    ).toBe(404);
  });

  it("mark a form submitted by the kit the page showed, and take it back", async () => {
    await seedSample();
    const cookie = await signedIn();
    // A form's draft: the cover note, and the drafter's topic for the post's question.
    const ready = await settled([
      answer(fixture("S17-form-ai-question")),
      answer({
        ...DRAFT,
        answers: [{ question_id: "Q1", topic: "years_with_skill", text: "", fact_ids: [] }],
      }),
    ]);
    await clearedOnPage(ready, cookie);
    const kit = await kitOf(ready);

    for (const body of ["", "{}", JSON.stringify({ kit: "", to: "" })]) {
      expect(
        (await submitted(post(`/api/jobs/${ready}/submitted`, body, cookie), deps(), ready)).status,
      ).toBe(400);
    }
    // A page that showed another kit, or one drawn before the page named the number it showed.
    for (const body of [{ kit: "another", to: "" }, { kit }]) {
      const stale = await submitted(
        post(`/api/jobs/${ready}/submitted`, JSON.stringify(body), cookie),
        deps(),
        ready,
      );
      expect(stale.status).toBe(409);
    }
    const response = await submitted(
      post(`/api/jobs/${ready}/submitted`, JSON.stringify({ kit, to: "" }), cookie),
      deps(),
      ready,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    const view = (await jobView({ db, clock }, ready))!;
    expect(view.application?.status).toBe("submitted");
    const submittedAt = view.application!.submittedAt!.toISOString();
    const taken = await takeBack(
      post(`/api/jobs/${ready}/take-back`, JSON.stringify({ submittedAt }), cookie),
      deps(),
      ready,
    );
    expect(taken.status).toBe(200);
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("kit_ready");
  });

  it("draft a message, not a template's email, for a WhatsApp post, and mark it submitted", async () => {
    await seedSample();
    const cookie = await signedIn();
    // A company named, so the sample profile's template fits the role, as it would an email's.
    const record = fixture("S05-whatsapp-local-number");
    record.company.name = "Contoso Labs";
    const ready = await settled([answer(record), answer(DRAFT)], true);

    const view = (await jobView({ db, clock }, ready))!;
    // The templates are emails: a message's route goes to draft.
    expect(view.drafts.map((draft) => draft.source)).toEqual(["gemini"]);
    expect(view.kit).toMatchObject({
      kind: "message",
      blocks: [{ text: "I have built production React applications for five years." }],
      signOff: expect.stringMatching(/^Sam Rivera/),
    });
    expect(view.kitRoute).toBe("message");
    await clearedOnPage(ready, cookie, "0300 0000000");
    const shown = (await jobView({ db, clock }, ready))!;
    expect(shown.review?.gate).toEqual([]);
    // Its words are a message's, which the gate's answer names.
    const answered = await (
      await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready)
    ).json();
    expect(answered.words).toBe(shown.wordsKey);
    const response = await submitted(
      post(
        `/api/jobs/${ready}/submitted`,
        JSON.stringify({ kit: shown.kitKey, to: shown.handoff?.to ?? "" }),
        cookie,
      ),
      deps(),
      ready,
    );
    expect(response.status).toBe(200);
    expect((await jobView({ db, clock }, ready))!.application?.status).toBe("submitted");
  });

  it("answers the gate with the email's words, which an edit changes", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const first = await (await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready)).json();
    expect(first.words).toEqual(expect.any(String));
    const block = (await jobView({ db, clock }, ready))!.draft!.kit.blocks[0]!;

    await recordReview({ db, clock, dns: offlineDns() }, ready, {
      kind: "edit",
      blockId: block.id,
      text: "I have built production React applications for four years.",
    });

    const second = await (await gate(get(`/api/jobs/${ready}/gate`, cookie), deps(), ready)).json();
    expect(second.words).not.toBe(first.words);
    expect(second.kit).toBe(first.kit);
  });

  it("record a handoff the page posts, naming the kit and the words it showed, and refuse one from a page that showed others", async () => {
    await seedSample();
    const cookie = await signedIn();
    const ready = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const kit = await kitOf(ready);
    const words = await wordsOf(ready);
    const handOff = (body: object, by?: string) =>
      handoff(post(`/api/jobs/${ready}/handoff`, JSON.stringify(body), by), deps(), ready);

    expect((await handOff({ kit, words, parts: ["body"] }, cookie)).status).toBe(200);
    // The body alone, as Copy email gives it, with the draft its words were.
    expect((await jobView({ db, clock }, ready))!.review!.decisions.handoff).toMatchObject({
      subject: null,
      body: { draft: "gemini", words, changed: [], factual: false },
    });
    expect((await handOff({ kit, words, parts: ["cc"] }, cookie)).status).toBe(400);
    expect((await handOff({ kit, words: "00000000" }, cookie)).status).toBe(409);
    expect((await handOff({ kit }, cookie)).status).toBe(400);
    expect((await handOff({ kit, words })).status).toBe(401);
  });

  it("keep for evaluation only a job with screenshots, and only from a signed-in browser", async () => {
    await seedSample();
    const cookie = await signedIn();
    const pasted = await settled([answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const keepIt = (by?: string) =>
      keepForEval(
        post(`/api/jobs/${pasted}/keep`, JSON.stringify({ kept: true }), by),
        deps(),
        pasted,
      );

    const refused = await keepIt(cookie);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no-images" });
    expect((await keepIt()).status).toBe(401);
  });

  it("apply again on the matches the banner showed, and on no others", async () => {
    await seedSample();
    const cookie = await signedIn();
    const record = fixture("S01-email-simple");
    await sentEarlier(record.company.name, record.roles[0]!.title);
    const ready = await settled([answer(record), answer(DRAFT)]);
    const keys = (await jobView({ db, clock }, ready))!.duplicates.map((match) => match.key);
    expect(keys).toHaveLength(1);
    const applyAgain = (body: string) =>
      applyAgainRoute(post(`/api/jobs/${ready}/apply-again`, body, cookie), deps(), ready);
    const kit = await kitOf(ready);

    expect((await applyAgain(JSON.stringify({ keys: ["application:x:post"], kit }))).status).toBe(
      409,
    );
    expect((await applyAgain(JSON.stringify({ keys }))).status).toBe(400);
    expect((await applyAgain(JSON.stringify({ keys, kit }))).status).toBe(200);
    expect((await jobView({ db, clock }, ready))!.duplicates[0]!.covered).toBe(true);
  });

  it("hold a kit again once the bounce of an earlier email that Apply again went past is taken back", async () => {
    await seedSample();
    const cookie = await signedIn();
    const record = fixture("S01-email-simple");
    const earlier = await sentEarlier(record.company.name, record.roles[0]!.title);
    clock.advance(60_000);
    await changeStatus({ db, clock }, earlier, "bounced", null);
    const ready = await settled([answer(record), answer(DRAFT)]);
    const keys = (await jobView({ db, clock }, ready))!.duplicates.map((match) => match.key);
    expect(keys).toEqual([expect.stringMatching(/:bounced$/)]);
    const kit = await kitOf(ready);
    const applyAgain = () =>
      applyAgainRoute(
        post(`/api/jobs/${ready}/apply-again`, JSON.stringify({ keys, kit }), cookie),
        deps(),
        ready,
      );
    expect((await applyAgain()).status).toBe(200);
    expect((await jobView({ db, clock }, ready))!.duplicates[0]!.covered).toBe(true);

    // The earlier email reached them after all: its bounce is taken back.
    const { rows } = await db.query<{ bounced_at: Date }>(
      "select bounced_at from {{schema}}.applications where id = $1",
      [earlier],
    );
    await undoStatus({ db, clock }, earlier, { status: "bounced", at: rows[0]!.bounced_at }, null);

    const view = (await jobView({ db, clock }, ready))!;
    expect(view.duplicates).toEqual([expect.objectContaining({ bounced: false, covered: false })]);
    expect(view.review?.gate.map((reason) => reason.kind)).toContain("duplicate");
    // A tap from a page that still showed the bounce is refused.
    expect((await applyAgain()).status).toBe(409);
  });

  it("pick a draft, ask Gemini for one beside the templates', and go back when it fails", async () => {
    await seedSample();
    const cookie = await signedIn();
    const id = await settled([answer(fixture("S01-email-simple"))], true);
    expect((await jobView({ db, clock }, id))!.drafts.map((draft) => draft.id)).toEqual([
      "T-full-stack",
      "T-ai-features",
    ]);
    const kit = await kitOf(id);
    const pickOne = (body: string) =>
      pick(post(`/api/jobs/${id}/pick`, body, cookie), deps(true), id);

    expect((await pickOne(JSON.stringify({ draft: "T-ai-features" }))).status).toBe(400);
    expect((await pickOne(JSON.stringify({ draft: "T-elsewhere", kit }))).status).toBe(409);
    const picked = await pickOne(JSON.stringify({ draft: "T-ai-features", kit }));
    expect(picked.status).toBe(200);
    // These routes run no address stages, so the address waits for the owner on every draft.
    expect(
      ((await picked.json()) as { gate: { kind: string }[] }).gate.map((reason) => reason.kind),
    ).toEqual(["contact"]);
    expect((await jobView({ db, clock }, id))!.picked).toBe("T-ai-features");

    const ask = (body: string) =>
      geminiDraft(post(`/api/jobs/${id}/draft-with-gemini`, body, cookie), deps(true), id);
    expect((await ask(JSON.stringify({ kit }))).status).toBe(409);
    expect((await ask(JSON.stringify({ kit: await kitOf(id) }))).status).toBe(202);
    // Gemini refuses: the job fails at draft, and goes back to the templates' drafts.
    await drain([refusal()]);
    expect(await stateOf(id)).toBe("failed");
    const back = () =>
      backToDrafts(post(`/api/jobs/${id}/back-to-drafts`, "", cookie), deps(true), id);
    expect((await back()).status).toBe(200);
    expect(await stateOf(id)).toBe("kit_ready");
    expect((await jobView({ db, clock }, id))!.picked).toBe("T-ai-features");
    expect((await back()).status).toBe(409);

    // Asked again, Gemini drafts: its draft ranks among the templates'.
    expect((await ask(JSON.stringify({ kit: await kitOf(id) }))).status).toBe(202);
    await drain([answer(DRAFT)]);
    expect(await stateOf(id)).toBe("kit_ready");
    expect((await jobView({ db, clock }, id))!.drafts.map((draft) => draft.id)).toContain("gemini");
  });

  it("refuse another origin, a missing session and an unknown job", async () => {
    const cookie = await signedIn();
    const id = await settled([answer(fixture("S08-urdu"))]);
    const actions = [
      retry,
      skip,
      role,
      readAgain,
      draftAnyway,
      sent,
      review,
      applyAgainRoute,
      takeBack,
      pick,
      geminiDraft,
      backToDrafts,
      bounced,
      submitted,
    ] as const;

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
