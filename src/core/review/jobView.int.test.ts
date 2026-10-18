import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm, type FakeStep } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { offlineDns } from "@/adapters/dns";
import { draftStage } from "@/core/drafting/draftStage";
import { noTemplateDrafts } from "@/core/drafting/testTemplates";
import { addressReadStage } from "@/core/extraction/addressReadStage";
import type { DraftAnswer } from "@/core/drafting/kit";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import { confirmPost, pickRole, skipRolePick } from "@/core/extraction/owner";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import { setRoute, undoStatus } from "@/core/ledger/statuses";
import type { ModelCallDeps } from "@/core/platform/models";
import { loadJob, moveJob, skipJob } from "@/core/platform/jobs";
import { claimJob, type Pipeline, runJob } from "@/core/platform/runner";
import type { Db, QueryResult, Row } from "@/core/ports";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import { addressChecksStage } from "./addressChecksStage";
import { flagKey } from "./decisions";
import { draftWithGemini, pickDraft } from "./draftChoice";
import { jobView, listJobViews } from "./jobView";
import { applyAgainForJob, recordReview } from "./kitReview";
import { trackApplications, skippedForJob } from "./applications";
import { STUCK_MS } from "./kitSends";
import { markBounced, takeBackBounced } from "./markBounced";
import { markSubmitted, takeBackSubmitted } from "./markSubmitted";
import { markSent, markSentByJobkit, takeBackSent } from "./markSent";
import { scheduleSend } from "./send";
import { closeSkipped, skipKit, takeBackSkip } from "./skipKit";

/**
 * The owner clears what holds a kit, as before sending it: the address no
 * second read confirmed, typed as the post gives it, each sentence and flag
 * checked, each file promised.
 */
async function cleared(id: string, typed = "jobs@example.com"): Promise<void> {
  const decide = (action: Parameters<typeof recordReview>[2]) =>
    recordReview({ db, clock, dns: offlineDns() }, id, action);
  const view = (await jobView({ db, clock }, id))!;
  if (view.kitParts?.contact?.needsRetype) {
    await decide({ kind: "retype", value: typed });
  }
  for (const reason of view.review?.gate ?? []) {
    if (reason.kind === "judge") await decide({ kind: "check", blockId: reason.blockId });
  }
  for (const flag of view.kitParts?.flags ?? []) {
    await decide({ kind: "check_flag", flag: flagKey(flag) });
  }
  for (const attachment of view.kitParts?.attachments ?? []) {
    await decide({ kind: "attach", id: attachment.id, ticked: true });
  }
}

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
  templates: noTemplateDrafts(),
  draft: draftStage({ db, random, models: models() }),
  // The judge has its own tests; here it passes every kit.
  judge: {
    callsModel: false,
    input: () => ({}),
    run: async () => ({
      ok: true as const,
      output: { checked: true, verdicts: [], markers: [] },
    }),
    next: () => ({ state: "kit_ready" as const, pending: null }),
  },
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

async function run(
  id: string,
  steps: readonly FakeStep[],
  stages: Pipeline = pipeline(),
): Promise<void> {
  llm = fakeLlm(steps);
  const deps = { db, clock, pipeline: stages };
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
    `delete from {{schema}}.kit_sends; delete from {{schema}}.kit_reviews; delete from {{schema}}.status_changes;
     delete from {{schema}}.applications;
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
  it("shows a ready kit with every step done", async () => {
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
    // No template fits in this pipeline, so Gemini drafted the kit.
    expect(view.steps.map(({ label, status }) => [label, status])).toEqual([
      ["Read the post", "done"],
      ["Check eligibility", "done"],
      ["Draft from your templates", "none_fit"],
      ["Write a draft with Gemini", "done"],
      ["Check every sentence separately", "done"],
    ]);
    expect(view.role?.id).toBe("P1");
    expect(view.draft?.kit.subject).toBe("Application - Senior Full-Stack Engineer - Sam Rivera");
  });

  it("shows a step whose output is from before its check was built as not checked", async () => {
    await seedSample();
    const id = await pasted();
    const stages = pipeline();
    // The thin path's first judge passed every kit through with no verdicts.
    const passThrough = {
      ...stages.judge,
      run: async () => ({ ok: true as const, output: { checked: false } }),
    };
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], {
      ...stages,
      judge: passThrough,
    });

    const view = (await jobView({ db, clock }, id))!;

    expect(view.steps.map(({ stage, status }) => [stage, status])).toEqual([
      ["extract", "done"],
      ["eligibility", "done"],
      ["templates", "none_fit"],
      ["draft", "done"],
      ["judge", "not_checked"],
    ]);
    expect(view.judge).toBeNull();
  });

  it("shows the old eligibility pass-through's output as not checked", async () => {
    await seedSample();
    const id = await pasted();
    const stages = pipeline();
    // The thin path's first eligibility stage stored only this.
    const passThrough = {
      ...stages.eligibility,
      run: async () => ({ ok: true as const, output: { result: "not_checked" } }),
      next: () => ({ state: "drafting" as const, pending: "draft" as const }),
    };
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], {
      ...stages,
      eligibility: passThrough,
    });

    const view = (await jobView({ db, clock }, id))!;

    expect(view.steps.find((step) => step.stage === "eligibility")?.status).toBe("not_checked");
    expect(view.eligibility).toBeNull();
  });

  it("shows how the contact's second read settled, and the address's checks", async () => {
    await seedSample();
    const stages = pipeline();
    const beside: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read", "address_checks"] },
      address_read: addressReadStage({ db, storage, random, models: models() }),
      address_checks: addressChecksStage({ db, dns: offlineDns() }),
    };
    // S01's address is in the pasted text: the second read agrees.
    const found = await pasted("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await run(found, [answer(fixture("S01-email-simple")), answer(DRAFT)], beside);

    expect(await jobView({ db, clock }, found)).toMatchObject({
      state: "kit_ready",
      contact: { kind: "email", agreement: { ok: true } },
      addressChecks: [{ kind: "company", blocking: false }],
    });

    const missing = await pasted("Northwind Analytics is hiring. Apply on our site.");
    await run(missing, [answer(fixture("S01-email-simple")), answer(DRAFT)], beside);

    expect((await jobView({ db, clock }, missing))?.contact).toEqual({
      kind: "email",
      agreement: { ok: false, reason: "not_in_text" },
      cropPath: null,
    });
  });

  it("blocks an address whose checks are for another address, or missing after the read", async () => {
    await seedSample();
    const stages = pipeline();
    const beside: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read", "address_checks"] },
      address_read: addressReadStage({ db, storage, random, models: models() }),
      address_checks: addressChecksStage({ db, dns: offlineDns() }),
    };
    const id = await pasted("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], beside);
    await db.query(
      `update {{schema}}.job_stage_runs
          set output = jsonb_set(output, '{address}', '"earlier@example.com"')
        where job_id = $1 and stage = 'address_checks'`,
      [id],
    );

    expect((await jobView({ db, clock }, id))?.addressChecks).toEqual([
      {
        kind: "not_checked",
        blocking: true,
        message: "This address has not been checked as it stands. Check it against the post.",
      },
    ]);
  });

  it("blocks an address as not checked when its kept checks stopped at a stricter rule it now passes", async () => {
    await seedSample();
    const stages = pipeline();
    const beside: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read", "address_checks"] },
      address_read: addressReadStage({ db, storage, random, models: models() }),
      address_checks: addressChecksStage({ db, dns: offlineDns() }),
    };
    const id = await pasted("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], beside);
    // As an older, stricter rule left them: the strict check failed, so no other check ran.
    await db.query(
      `update {{schema}}.job_stage_runs
          set output = jsonb_set(output, '{checks}', $2::jsonb)
        where job_id = $1 and stage = 'address_checks'`,
      [
        id,
        JSON.stringify([
          {
            kind: "syntax",
            blocking: true,
            message: "This address did not pass the strict check. Type it yourself from the post.",
          },
        ]),
      ],
    );

    expect((await jobView({ db, clock }, id))?.addressChecks).toEqual([
      {
        kind: "not_checked",
        blocking: true,
        message: "This address has not been checked as it stands. Check it against the post.",
      },
    ]);
  });

  it("marks the email's step failed when a stage beside the draft fails the job", async () => {
    await seedSample();
    const stages = pipeline();
    const broken: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read"] },
      address_read: {
        callsModel: false,
        input: () => ({}),
        run: async () => ({ ok: false as const, reason: "The second read broke.", retry: false }),
      },
    };
    const id = await pasted("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], broken);

    const view = (await jobView({ db, clock }, id))!;

    expect(view.failure?.stage).toBe("address_read");
    expect(view.steps.find((step) => step.stage === "draft")?.status).toBe("failed");
  });

  it("takes a read made for another contact as no second read of this one", async () => {
    await seedSample();
    const stages = pipeline();
    const beside: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read"] },
      address_read: addressReadStage({ db, storage, random, models: models() }),
    };
    const id = await pasted("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], beside);
    // As if the role, or its contact, had changed since the read, which made a crop.
    await db.query(
      `update {{schema}}.job_stage_runs
          set output = jsonb_set(jsonb_set(output, '{contact}', '"someone@else.example"'),
                                 '{cropPath}', to_jsonb($2::text))
        where job_id = $1 and stage = 'address_read'`,
      [id, `jobs/${id}/crops/a.png`],
    );

    // Nor is its crop shown for this one.
    expect((await jobView({ db, clock }, id))?.contact).toEqual({
      kind: "email",
      agreement: { ok: false, reason: "no_second_read" },
      cropPath: null,
    });
  });

  /** A kit whose contact the second read confirmed from the pasted text, its checks passed. */
  async function agreedKit(): Promise<string> {
    const stages = pipeline();
    const beside: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read", "address_checks"] },
      address_read: addressReadStage({ db, storage, random, models: models() }),
      address_checks: addressChecksStage({ db, dns: offlineDns() }),
    };
    const id = await pasted("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)], beside);
    return id;
  }

  /** As a job from one screenshot of the post, one tile, with the contact's box where given. */
  async function onScreenshot(
    id: string,
    box = { tile: 1, x1: 100, y1: 900, x2: 700, y2: 960 },
  ): Promise<void> {
    await db.query(
      `insert into {{schema}}.job_images
         (id, job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
          tile_count, created_at, purge_after)
       values (gen_random_uuid(), $1, 0, 'post', $2, 'image/webp', 1080, 2400, 3, $3, 1, now(),
               now() + interval '30 days')`,
      [id, `jobs/${id}/0.webp`, "0".repeat(64)],
    );
    await db.query(
      `update {{schema}}.job_stage_runs
          set output = jsonb_set(jsonb_set(output, '{tiles}', $2::jsonb),
                                 '{record,roles,0,route,box}', $3::jsonb)
        where job_id = $1 and stage = 'extract'`,
      [id, JSON.stringify([{ image: 0, top: 0, width: 1080, height: 2400 }]), JSON.stringify(box)],
    );
  }

  it("asks for the contact typed from the screenshots when its box lies on one but there is no crop of it", async () => {
    await seedSample();
    const id = await agreedKit();
    const agreed = (await jobView({ db, clock }, id))!;
    expect(agreed.noCrop).toBe(false);
    expect(agreed.kitParts?.contact?.needsRetype).toBe(false);
    // Pasted text alone: no cut-out could be made, so no screenshot is looked for.
    expect(agreed.images).toEqual({ cropPath: null, screenshots: "never", first: null });

    // The contact's box lies on a screenshot, but its crop could not be stored.
    await onScreenshot(id);
    const held = (await jobView({ db, clock }, id))!;
    expect(held.noCrop).toBe(true);
    expect(held.kitParts?.contact?.needsRetype).toBe(true);
    expect(held.handoff).toEqual({ to: "", typed: true });
    expect(held.images).toEqual({ cropPath: null, screenshots: "always", first: 0 });

    // With a crop of it to show beside it, the reads' agreement stands.
    await db.query(
      `update {{schema}}.job_stage_runs set output = jsonb_set(output, '{cropPath}', to_jsonb($2::text))
        where job_id = $1 and stage = 'address_read'`,
      [id, `jobs/${id}/crops/a.png`],
    );
    const cropped = (await jobView({ db, clock }, id))!;
    expect(cropped.noCrop).toBe(false);
    expect(cropped.kitParts?.contact?.needsRetype).toBe(false);
    expect(cropped.images).toEqual({
      cropPath: `jobs/${id}/crops/a.png`,
      screenshots: "without-crop",
      first: 0,
    });
  });

  it("asks nothing more of a job with screenshots whose contact the pasted text settled", async () => {
    await seedSample();
    const id = await agreedKit();
    // A share of a screenshot and a caption: the contact's box lies on no screenshot.
    await onScreenshot(id, { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 });

    const view = (await jobView({ db, clock }, id))!;

    expect(view.noCrop).toBe(false);
    expect(view.kitParts?.contact?.needsRetype).toBe(false);
    expect(view.handoff).toEqual({ to: "jobs@example.com", typed: false });
    // No cut-out was possible, and the contact is not on the screenshots: none is shown.
    expect(view.images).toEqual({ cropPath: null, screenshots: "never", first: null });
  });

  it("shows where a kit went, as the ledger keeps it, with no screenshots until it bounced", async () => {
    await seedSample();
    const sent = await agreedKit();
    await cleared(sent);
    await markSent({ db, clock }, sent, null, { changedInGmail: false });
    // As after an update whose rule would ask for the contact typed.
    await onScreenshot(sent);

    const went = (await jobView({ db, clock }, sent))!;
    expect(went.noCrop).toBe(false);
    expect(went.wentTo).toBe("jobs@example.com");
    expect(went.images).toEqual({ cropPath: null, screenshots: "never", first: 0 });

    // Bounced: the owner checks the address against the post again.
    await markBounced({ db, clock }, sent, null, went.application!.sentAt!);
    expect((await jobView({ db, clock }, sent))!.images?.screenshots).toBe("always");
  });

  it("shows where a kit went when the owner typed the address of a contact with no crop", async () => {
    await seedSample();
    const id = await agreedKit();
    await onScreenshot(id);
    await cleared(id, "hr@example.com");
    expect((await jobView({ db, clock }, id))!.wentTo).toBeNull();
    await markSent({ db, clock }, id, null, { changedInGmail: false });

    const view = (await jobView({ db, clock }, id))!;

    expect(view.wentTo).toBe("hr@example.com");
    expect(view.noCrop).toBe(false);
  });

  it("keeps a skipped kit's contact as it was, unconfirmed while it has no crop", async () => {
    await seedSample();
    const skipped = await agreedKit();
    await onScreenshot(skipped);
    const kit = (await jobView({ db, clock }, skipped))!.kitKey!;
    await skipKit({ db, clock }, skipped, null, { kit, uncertain: null });

    const view = (await jobView({ db, clock }, skipped))!;

    expect(view.noCrop).toBe(true);
    expect(view.handoff).toEqual({ to: "", typed: true });
    expect(view.images?.screenshots).toBe("always");
  });

  it("names the screenshot the contact's box lies on", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    expect((await jobView({ db, clock }, id))!.contactScreenshot).toBeNull();

    // As a post of two screenshots, each one tile, with the contact on the second.
    await db.query(
      `update {{schema}}.job_stage_runs
          set output = jsonb_set(jsonb_set(output, '{tiles}', $2::jsonb),
                                 '{record,roles,0,route,box}', $3::jsonb)
        where job_id = $1 and stage = 'extract'`,
      [
        id,
        JSON.stringify([
          { image: 0, top: 0, width: 1080, height: 1800 },
          { image: 1, top: 0, width: 1080, height: 1800 },
        ]),
        JSON.stringify({ tile: 2, x1: 100, y1: 900, x2: 700, y2: 960 }),
      ],
    );
    expect((await jobView({ db, clock }, id))!.contactScreenshot).toBe(1);
  });

  it("has no second read for a job whose read never ran", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);

    expect(await jobView({ db, clock }, id)).toMatchObject({ contact: null, addressChecks: null });
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

describe("a post's scam signs", () => {
  it("stay with the post, and hold the kit back, whichever role the owner picks (extraction AC7)", async () => {
    await seedSample();
    const post: JobRecord = {
      ...fixture("S07-two-roles"),
      scam_signals: fixture("S10-scam").scam_signals,
    };
    const claim = DRAFT.blocks[0]!;
    const drafts: Record<string, DraftAnswer> = {
      P1: {
        fit: [{ requirement_id: "R1", verdict: "met", fact_ids: ["F-node-apis"], note: "" }],
        blocks: [{ ...claim, text: "I have built Node.js APIs.", fact_ids: ["F-node-apis"] }],
      },
      P2: {
        fit: [
          { requirement_id: "R1", verdict: "gap", fact_ids: [], note: "" },
          { requirement_id: "R2", verdict: "gap", fact_ids: [], note: "" },
        ],
        blocks: [claim],
      },
    };

    for (const pick of ["P1", "P2"]) {
      const id = await pasted("We're hiring two engineers. Apply by email.");
      await run(id, [answer(post)]);
      expect(await pickRole({ db, clock }, id, pick)).toEqual({ ok: true });
      await run(id, [answer(drafts[pick]!)]);

      const view = (await jobView({ db, clock }, id))!;
      expect(view).toMatchObject({ state: "kit_ready", role: { id: pick } });
      expect(view.extraction?.record.scam_signals).toEqual(post.scam_signals);
      expect(view.kitParts?.scamSignals).toEqual(post.scam_signals.map((signal) => signal.quote));
      expect(view.review?.gate.map((reason) => reason.kind)).toContain("scam");
    }
  });
});

describe("markSent", () => {
  it("takes back a Mark sent on a kit it can no longer read, as the ledger allows", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(id);
    await markSent({ db, clock }, id, null, { changedInGmail: false });
    const sentAt = (await jobView({ db, clock }, id))!.application!.sentAt!;
    // As after an update: the kit's draft can no longer be read.
    await db.query(
      "update {{schema}}.job_stage_runs set output = '{}'::jsonb where job_id = $1 and stage = 'draft'",
      [id],
    );

    expect(await takeBackSent({ db, clock }, id, null, sentAt)).toEqual({ ok: true });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("kit_ready");
  });

  it("records the application as sent once, with the role's address and the email route", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(id);

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
      skippedAt: null,
      bouncedAt: null,
      submittedAt: null,
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

  it("records sent and the Gmail answer together, or neither", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    // A database that loses the outcome's insert, as on a dropped connection.
    const losing = (inner: Db): Db => ({
      schema: inner.schema,
      query: <T extends Row = Row>(sql: string, params?: readonly unknown[]) =>
        sql.includes("draft_outcomes")
          ? Promise.reject<QueryResult<T>>(new Error("connection lost"))
          : inner.query<T>(sql, params),
      exec: (sql) => inner.exec(sql),
      tx: (fn) => inner.tx((tx) => fn(losing(tx))),
    });
    const statuses = async () =>
      (
        await db.query<{ status: string }>(
          "select status from {{schema}}.applications where job_id = $1",
          [id],
        )
      ).rows.map((row) => row.status);
    await cleared(id);

    await expect(
      markSent({ db: losing(db), clock }, id, null, { changedInGmail: true }),
    ).rejects.toThrow("connection lost");
    // Nothing of the tap was kept: the application that would have opened with it included.
    expect(await statuses()).toEqual([]);

    // So the owner can answer again.
    expect(await markSent({ db, clock }, id, null, { changedInGmail: true })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await statuses()).toEqual(["sent"]);
  });

  it("takes back a sent tap's outcome with it, and records the answer given when sent again", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(id);
    await markSent({ db, clock }, id, null, { changedInGmail: true });
    const { rows } = await db.query<{ id: string; sent_at: Date }>(
      "select id, sent_at from {{schema}}.applications where job_id = $1",
      [id],
    );
    const outcomes = async () =>
      (
        await db.query<{ changed_in_gmail: boolean }>(
          "select changed_in_gmail from {{schema}}.draft_outcomes where job_id = $1",
          [id],
        )
      ).rows;

    const undone = await undoStatus(
      { db, clock },
      rows[0]!.id,
      { status: "sent", at: rows[0]!.sent_at },
      null,
    );
    expect(undone).toMatchObject({ ok: true, changed: true, status: "kit_ready" });
    expect(await outcomes()).toEqual([]);

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await outcomes()).toEqual([{ changed_in_gmail: false }]);
  });

  it("keeps a Gmail answer on an email kit's outcome, and only there (migration 0018)", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(id);
    await markSent({ db, clock }, id, null, { changedInGmail: false });

    await expect(
      db.query("update {{schema}}.draft_outcomes set changed_in_gmail = null where job_id = $1", [
        id,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query("update {{schema}}.draft_outcomes set kind = 'form' where job_id = $1", [id]),
    ).rejects.toThrow();
    await db.query(
      "update {{schema}}.draft_outcomes set kind = 'form', changed_in_gmail = null where job_id = $1",
      [id],
    );
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

describe("skipKit", () => {
  /** A ready kit as the app runs it: its application opened with the role, kit_ready with the kit. */
  async function readyKit(text?: string): Promise<string> {
    const id = await pasted(text);
    await run(
      id,
      [answer(fixture("S01-email-simple")), answer(DRAFT)],
      trackApplications(pipeline(), { db, clock }),
    );
    return id;
  }

  /** What the page showed as the owner pressed Skip: the kit, and a send that may have gone. */
  async function shownOn(id: string) {
    const view = (await jobView({ db, clock }, id))!;
    return { kit: view.kitKey, uncertain: view.uncertain?.id ?? null };
  }

  async function statusChanges(id: string) {
    const { rows } = await db.query<{ from_status: string | null; to_status: string }>(
      `select from_status, to_status from {{schema}}.status_changes
        where application_id = (select id from {{schema}}.applications where job_id = $1)
        order by changed_at, id`,
      [id],
    );
    return rows;
  }

  /** A send of the kit, left as it stands at `status`, its last change `ago` milliseconds back. */
  async function sendOf(id: string, status: string, ago = 0): Promise<string> {
    const at = new Date(clock.now().getTime() - ago);
    const { rows } = await db.query<{ id: string }>(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, created_at, updated_at)
       values ($1, 'P1', $2, 'jobs@example.com', $3, $4, $4, $4)
       returning id`,
      [id, (await jobView({ db, clock }, id))!.kitKey, status, at],
    );
    return rows[0]!.id;
  }

  it("skips a ready kit's application, holding everything outbound, and leaves the job and its kit as they were", async () => {
    await seedSample();
    const id = await readyKit();
    await cleared(id);
    clock.advance(1_000);
    const shown = await shownOn(id);

    expect(await skipKit({ db, clock }, id, null, shown)).toEqual({ ok: true, changed: true });
    expect(await skipKit({ db, clock }, id, null, shown)).toEqual({ ok: true, changed: false });

    const view = (await jobView({ db, clock }, id))!;
    expect(view).toMatchObject({ state: "kit_ready", role: { id: "P1" } });
    expect(view.draft).not.toBeNull();
    expect(view.application).toEqual({
      status: "skipped",
      sentAt: null,
      skippedAt: clock.now(),
      bouncedAt: null,
      submittedAt: null,
    });
    expect(view.review?.gate.map((reason) => reason.kind)).toEqual(["skipped"]);
    expect((await statusChanges(id)).at(-1)).toEqual({
      from_status: "kit_ready",
      to_status: "skipped",
    });
    // Nothing goes out while it is skipped, and nothing on the page changes the kit.
    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toEqual({
      ok: false,
      reason: "held",
    });
    expect(
      await scheduleSend({ db, clock }, id, {
        kit: view.kitKey!,
        to: view.handoff!.to,
        uncertain: null,
        sessionId: null,
      }),
    ).toEqual({ ok: false, reason: "skipped" });
    expect(
      await recordReview({ db, clock, dns: offlineDns() }, id, { kind: "check", blockId: "S1" }),
    ).toEqual({ ok: false, reason: "skipped" });
  });

  it("takes back the skip the page showed, opening the kit again, and never one a later skip replaced", async () => {
    await seedSample();
    const id = await readyKit();
    await cleared(id);
    const skippedAt = async () => (await jobView({ db, clock }, id))!.application!.skippedAt!;
    clock.advance(1_000);
    await skipKit({ db, clock }, id, null, await shownOn(id));
    const first = await skippedAt();
    clock.advance(1_000);
    expect(await takeBackSkip({ db, clock }, id, null, first)).toEqual({ ok: true });
    clock.advance(1_000);
    await skipKit({ db, clock }, id, null, await shownOn(id));
    const second = await skippedAt();
    clock.advance(1_000);

    // A page drawn before the owner skipped again shows the first skip: its tap changes nothing.
    expect(await takeBackSkip({ db, clock }, id, null, first)).toEqual({
      ok: false,
      reason: "not-skipped",
    });
    expect(await takeBackSkip({ db, clock }, id, null, second)).toEqual({ ok: true });
    expect(await takeBackSkip({ db, clock }, id, null, second)).toEqual({
      ok: false,
      reason: "not-skipped",
    });

    const view = (await jobView({ db, clock }, id))!;
    expect(view.application).toEqual({
      status: "kit_ready",
      sentAt: null,
      skippedAt: null,
      bouncedAt: null,
      submittedAt: null,
    });
    expect(view.review?.gate).toEqual([]);
    expect((await statusChanges(id)).slice(-4)).toEqual([
      { from_status: "kit_ready", to_status: "skipped" },
      { from_status: "skipped", to_status: "kit_ready" },
      { from_status: "kit_ready", to_status: "skipped" },
      { from_status: "skipped", to_status: "kit_ready" },
    ]);
  });

  it("takes back no skip of a job the skip closed, which stays closed", async () => {
    await seedSample();
    const id = await readyKit();
    // As when the owner went on to pick another role, then skipped the pick, which closed the job.
    const job = (await loadJob(db, id))!;
    expect(
      await moveJob(db, id, {
        from: "kit_ready",
        to: "needs_role_pick",
        pending: null,
        at: clock.now(),
        ifChangedAt: job.stateChangedAt,
      }),
    ).toBe(true);
    expect(await skipRolePick({ db, clock }, id)).toEqual({ ok: true });
    await skippedForJob({ db, clock }, id, null);
    const skippedAt = (await jobView({ db, clock }, id))!.application!.skippedAt!;

    expect(await takeBackSkip({ db, clock }, id, null, skippedAt)).toEqual({
      ok: false,
      reason: "not-ready",
    });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("skipped");
  });

  it("takes back no skip of an email Gmail took, though jobkit could not record it as sent", async () => {
    await seedSample();
    const id = await readyKit();
    await skipKit({ db, clock }, id, null, await shownOn(id));
    const skippedAt = (await jobView({ db, clock }, id))!.application!.skippedAt!;
    // The send went, but the ledger's write after it failed: the application is still skipped.
    await sendOf(id, "sent");

    expect(await takeBackSkip({ db, clock }, id, null, skippedAt)).toEqual({
      ok: false,
      reason: "sent",
    });
    // The page, the gate and the list all say it went.
    expect((await jobView({ db, clock }, id))!.review?.gate.map((reason) => reason.kind)).toEqual([
      "sent",
    ]);
    expect((await listJobViews({ db, clock })).find((each) => each.id === id)).toMatchObject({
      sent: true,
      skipped: false,
    });
  });

  it("refuses a skip from a page that showed another kit, or no warning of a send that may have gone, and skips past one it warned of", async () => {
    await seedSample();
    const id = await readyKit();
    const shown = await shownOn(id);

    expect(await skipKit({ db, clock }, id, null, { ...shown, kit: "another kit" })).toEqual({
      ok: false,
      reason: "changed",
    });
    // Gmail took a send whose answer was lost: it may have gone.
    const unknown = await sendOf(id, "unknown");
    expect(await skipKit({ db, clock }, id, null, shown)).toEqual({
      ok: false,
      reason: "uncertain",
    });
    expect(await skipKit({ db, clock }, id, null, { ...shown, uncertain: unknown })).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("marks sent, at the address it went to, an email that went after the owner skipped past the send that may have gone", async () => {
    await seedSample();
    const id = await readyKit();
    // A send left sending past its time: it may have gone, and may still go.
    const stuck = await sendOf(id, "sending", STUCK_MS + 1);
    await skipKit({ db, clock }, id, null, { ...(await shownOn(id)), uncertain: stuck });

    // Gmail took it after all, at another address than the post's: it went, so it is sent there.
    expect(await markSentByJobkit({ db, clock }, id, null, "hr@example.com")).toEqual({
      ok: true,
      changed: true,
    });
    const { rows } = await db.query<{ status: string; address: string }>(
      "select status, address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ status: "sent", address: "hr@example.com" }]);
  });

  it("refuses to skip a job whose post can no longer be read, for which the page offers no Skip", async () => {
    await seedSample();
    const id = await readyKit();
    // As after an update: the post's reading itself can no longer be read.
    await db.query(
      "update {{schema}}.job_stage_runs set output = '{}'::jsonb where job_id = $1 and stage = 'extract'",
      [id],
    );

    expect(await skipKit({ db, clock }, id, null, { kit: null, uncertain: null })).toEqual({
      ok: false,
      reason: "not-ready",
    });
  });

  it("skips a kit it can no longer read, while its post can still be read, past the send it warned of, and takes the skip back", async () => {
    await seedSample();
    const id = await readyKit();
    const stuck = await sendOf(id, "unknown");
    // As after an update: the kit's draft can no longer be read.
    await db.query(
      "update {{schema}}.job_stage_runs set output = '{}'::jsonb where job_id = $1 and stage = 'draft'",
      [id],
    );
    const shown = await shownOn(id);
    expect(shown).toEqual({ kit: null, uncertain: stuck });

    expect(await skipKit({ db, clock }, id, null, { kit: null, uncertain: null })).toEqual({
      ok: false,
      reason: "uncertain",
    });
    expect(await skipKit({ db, clock }, id, null, shown)).toEqual({ ok: true, changed: true });
    const skipped = (await jobView({ db, clock }, id))!.application!;
    expect(skipped.status).toBe("skipped");
    expect(await takeBackSkip({ db, clock }, id, null, skipped.skippedAt!)).toEqual({ ok: true });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("kit_ready");
  });

  it("opens the application of a kit from before applications opened with their jobs, with the address the owner typed", async () => {
    await seedSample();
    // No application: the pipeline here is not the app's, which opens one with the role.
    const id = await pasted("We're hiring a Senior Full-Stack Engineer.");
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    expect(
      await recordReview({ db, clock, dns: offlineDns() }, id, {
        kind: "retype",
        value: "hr@example.com",
      }),
    ).toMatchObject({ ok: true });

    expect(await skipKit({ db, clock }, id, null, await shownOn(id))).toEqual({
      ok: true,
      changed: true,
    });
    const { rows } = await db.query<{ status: string; address: string }>(
      "select status, address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ status: "skipped", address: "hr@example.com" }]);
  });

  it("refuses to skip a kit marked sent, one jobkit is sending, and a job with no ready kit", async () => {
    await seedSample();
    const sent = await readyKit();
    await cleared(sent);
    await markSent({ db, clock }, sent, null, { changedInGmail: false });
    expect(await skipKit({ db, clock }, sent, null, await shownOn(sent))).toEqual({
      ok: false,
      reason: "sent",
    });

    const sending = await readyKit();
    await sendOf(sending, "scheduled");
    expect(await skipKit({ db, clock }, sending, null, await shownOn(sending))).toEqual({
      ok: false,
      reason: "sending",
    });
    // Claimed by a delivery a moment ago: Gmail may be taking it now.
    const claimed = await readyKit();
    await sendOf(claimed, "sending");
    expect(await skipKit({ db, clock }, claimed, null, await shownOn(claimed))).toEqual({
      ok: false,
      reason: "sending",
    });

    const stopped = await pasted();
    await run(stopped, [answer({ ...fixture("S01-email-simple"), roles: [] })]);
    expect(await skipKit({ db, clock }, stopped, null, { kit: null, uncertain: null })).toEqual({
      ok: false,
      reason: "not-ready",
    });
    expect(
      await skipKit({ db, clock }, "33333333-3333-4333-8333-333333333333", null, {
        kit: null,
        uncertain: null,
      }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("takes no decision on a skipped kit: no other draft, no Gemini draft, no Apply again", async () => {
    await seedSample();
    const id = await readyKit();
    await skipKit({ db, clock }, id, null, await shownOn(id));
    const { picked } = (await jobView({ db, clock }, id))!;

    expect(await pickDraft({ db, clock }, id, picked!)).toEqual({ ok: false, reason: "skipped" });
    expect(await draftWithGemini({ db, clock }, id)).toEqual({ ok: false, reason: "skipped" });
    expect(await applyAgainForJob({ db, clock }, id, ["any"])).toEqual({
      ok: false,
      reason: "skipped",
    });
  });

  it("closes a failed job whose kit's send may have gone only from a page that warned of it, for good", async () => {
    await seedSample();
    const id = await readyKit();
    const stuck = await sendOf(id, "unknown");
    // As when a Gemini draft asked for beside the kit failed: the job waits on the owner.
    await db.query(
      "update {{schema}}.jobs set state = 'failed', pending_stage = 'draft', failed_stage = 'draft' where id = $1",
      [id],
    );

    const since = (await loadJob(db, id))!.stateChangedAt;

    expect(
      await closeSkipped({ db, clock }, id, null, { state: "failed", since, uncertain: null }),
    ).toEqual({ ok: false, reason: "uncertain" });
    expect((await loadJob(db, id))!.state).toBe("failed");
    expect(
      await closeSkipped({ db, clock }, id, null, { state: "failed", since, uncertain: stuck }),
    ).toEqual({ ok: true });
    expect((await loadJob(db, id))!.state).toBe("closed");
    const skipped = (await jobView({ db, clock }, id))!.application!;
    expect(skipped.status).toBe("skipped");
    // A skip that closed its job is never taken back, by the page or by the ledger.
    expect(await takeBackSkip({ db, clock }, id, null, skipped.skippedAt!)).toEqual({
      ok: false,
      reason: "not-ready",
    });
    const { rows } = await db.query<{ id: string }>(
      "select id from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(
      await undoStatus(
        { db, clock },
        rows[0]!.id,
        { status: "skipped", at: skipped.skippedAt! },
        null,
      ),
    ).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("markBounced", () => {
  /** A ready kit the owner marked sent after sending it from Gmail, and when, as the page shows it. */
  async function sentKit(): Promise<{ id: string; sentAt: Date }> {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(id);
    await markSent({ db, clock }, id, null, { changedInGmail: false });
    return { id, sentAt: (await jobView({ db, clock }, id))!.application!.sentAt! };
  }

  it("marks a sent email bounced, once, the kit still held as sent", async () => {
    const { id, sentAt } = await sentKit();
    clock.advance(60_000);

    expect(await markBounced({ db, clock }, id, null, sentAt)).toEqual({ ok: true, changed: true });
    expect(await markBounced({ db, clock }, id, null, sentAt)).toEqual({
      ok: true,
      changed: false,
    });

    const view = (await jobView({ db, clock }, id))!;
    expect(view.application).toEqual({
      status: "bounced",
      sentAt,
      skippedAt: null,
      bouncedAt: clock.now(),
      submittedAt: null,
    });
    // It went, and came back: nothing goes out from the page again.
    expect(view.went).toBe(true);
    expect(view.review?.gate.map((reason) => reason.kind)).toEqual(["sent"]);
    // Its Mark sent is taken back only once the bounce is.
    expect(await takeBackSent({ db, clock }, id, null, sentAt)).toEqual({
      ok: false,
      reason: "not-sent",
    });
  });

  it("takes back the bounce the page showed, the email sent as it was, and never a later bounce", async () => {
    const { id, sentAt } = await sentKit();
    clock.advance(60_000);
    await markBounced({ db, clock }, id, null, sentAt);
    const bouncedAt = (await jobView({ db, clock }, id))!.application!.bouncedAt!;
    clock.advance(60_000);

    expect(await takeBackBounced({ db, clock }, id, null, bouncedAt)).toEqual({ ok: true });
    expect((await jobView({ db, clock }, id))!.application).toEqual({
      status: "sent",
      sentAt,
      skippedAt: null,
      bouncedAt: null,
      submittedAt: null,
    });
    expect(await takeBackBounced({ db, clock }, id, null, bouncedAt)).toEqual({
      ok: false,
      reason: "not-bounced",
    });
    // Marked bounced again: a late tap from the page that showed the first bounce changes nothing.
    await markBounced({ db, clock }, id, null, sentAt);
    expect(await takeBackBounced({ db, clock }, id, null, bouncedAt)).toEqual({
      ok: false,
      reason: "not-bounced",
    });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("bounced");
  });

  it("takes back a Mark sent whose bounce was taken back, by the Mark sent the page shows", async () => {
    const { id, sentAt } = await sentKit();
    clock.advance(60_000);
    await markBounced({ db, clock }, id, null, sentAt);
    const bouncedAt = (await jobView({ db, clock }, id))!.application!.bouncedAt!;
    clock.advance(60_000);
    expect(await takeBackBounced({ db, clock }, id, null, bouncedAt)).toEqual({ ok: true });
    clock.advance(60_000);

    expect((await jobView({ db, clock }, id))!.application?.sentAt).toEqual(sentAt);
    expect(await takeBackSent({ db, clock }, id, null, sentAt)).toEqual({ ok: true });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("kit_ready");
  });

  it("keeps the gate in the kit's review row as it marks an email bounced, as the other moves do", async () => {
    const { id, sentAt } = await sentKit();
    // A review row made afresh, as for a kit no decision was made on before.
    await db.query("delete from {{schema}}.kit_reviews where job_id = $1", [id]);

    await markBounced({ db, clock }, id, null, sentAt);
    const { rows } = await db.query<{ gate: { kind: string }[] }>(
      "select gate from {{schema}}.kit_reviews where job_id = $1",
      [id],
    );
    expect(rows.map((row) => row.gate.map((reason) => reason.kind))).toEqual([["sent"]]);
  });

  it("refuses a bounce of an email not sent, or from a page that showed another Mark sent", async () => {
    const { id, sentAt } = await sentKit();
    clock.advance(60_000);
    // The owner took the Mark sent back, then marked it sent again, since that page was drawn.
    expect(await takeBackSent({ db, clock }, id, null, sentAt)).toEqual({ ok: true });
    expect(await markBounced({ db, clock }, id, null, sentAt)).toEqual({
      ok: false,
      reason: "not-sent",
    });
    await markSent({ db, clock }, id, null, { changedInGmail: false });

    expect(await markBounced({ db, clock }, id, null, sentAt)).toEqual({
      ok: false,
      reason: "changed",
    });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("sent");
    expect(
      await markBounced({ db, clock }, "33333333-3333-4333-8333-333333333333", null, sentAt),
    ).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("markSubmitted", () => {
  /** A ready kit for a post that asks for a form or a message, its gate cleared, and what the page shows. */
  async function readyFor(post: string): Promise<{ id: string; kit: string }> {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture(post)), answer(DRAFT)]);
    await cleared(id);
    return { id, kit: (await jobView({ db, clock }, id))!.kitKey! };
  }

  it("marks a form or message kit submitted once, the kit then held as gone", async () => {
    for (const post of ["S17-form-ai-question", "S16-linkedin-dm"]) {
      const { id, kit } = await readyFor(post);
      clock.advance(60_000);

      expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
        ok: true,
        changed: true,
      });
      expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
        ok: true,
        changed: false,
      });

      const view = (await jobView({ db, clock }, id))!;
      expect(view.application).toMatchObject({ status: "submitted", submittedAt: clock.now() });
      expect(view.went).toBe(true);
      expect(view.review?.gate.map((reason) => reason.kind)).toEqual(["sent"]);
      expect(view.review?.gate[0]!.message).toMatch(/submitted/);
    }
  });

  it("takes back the Mark submitted the page showed, opening the kit again, and never a later one", async () => {
    const { id, kit } = await readyFor("S17-form-ai-question");
    await markSubmitted({ db, clock }, id, null, { kit, to: "" });
    const submittedAt = (await jobView({ db, clock }, id))!.application!.submittedAt!;
    clock.advance(60_000);

    expect(await takeBackSubmitted({ db, clock }, id, null, submittedAt)).toEqual({ ok: true });
    const view = (await jobView({ db, clock }, id))!;
    expect(view.application?.status).toBe("kit_ready");
    expect(view.review?.gate).toEqual([]);
    expect(await takeBackSubmitted({ db, clock }, id, null, submittedAt)).toEqual({
      ok: false,
      reason: "not-submitted",
    });
    // Submitted again: a late tap from the page that showed the first changes nothing.
    await markSubmitted({ db, clock }, id, null, { kit, to: "" });
    expect(await takeBackSubmitted({ db, clock }, id, null, submittedAt)).toEqual({
      ok: false,
      reason: "not-submitted",
    });
  });

  it("refuses an email kit, a kit the page did not show, and one the gate holds", async () => {
    await seedSample();
    const email = await pasted();
    await run(email, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(email);
    const emailKit = (await jobView({ db, clock }, email))!.kitKey!;
    expect(await markSubmitted({ db, clock }, email, null, { kit: emailKit, to: "" })).toEqual({
      ok: false,
      reason: "not-form-or-message",
    });

    const { id, kit } = await readyFor("S17-form-ai-question");
    expect(await markSubmitted({ db, clock }, id, null, { kit: "another kit", to: "" })).toEqual({
      ok: false,
      reason: "changed",
    });
    // Held: the owner skipped it, so nothing could have gone from the page.
    await skipKit({ db, clock }, id, null, { kit, uncertain: null });
    expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
      ok: false,
      reason: "held",
    });
    expect(
      await markSubmitted({ db, clock }, "33333333-3333-4333-8333-333333333333", null, {
        kit,
        to: "",
      }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("moves the application the app opened with the role from kit_ready to submitted, with its audit row", async () => {
    await seedSample();
    const id = await pasted();
    await run(
      id,
      [answer(fixture("S17-form-ai-question")), answer(DRAFT)],
      trackApplications(pipeline(), { db, clock }),
    );
    await cleared(id);
    const view = (await jobView({ db, clock }, id))!;
    expect(view.application?.status).toBe("kit_ready");
    clock.advance(60_000);

    expect(await markSubmitted({ db, clock }, id, null, { kit: view.kitKey!, to: "" })).toEqual({
      ok: true,
      changed: true,
    });
    const { rows } = await db.query<{ from_status: string | null; to_status: string }>(
      `select c.from_status, c.to_status from {{schema}}.status_changes c
         join {{schema}}.applications a on a.id = c.application_id
        where a.job_id = $1 and c.to_status in ('kit_ready', 'submitted')
        order by c.changed_at`,
      [id],
    );
    expect(rows).toEqual([
      { from_status: "open", to_status: "kit_ready" },
      { from_status: "kit_ready", to_status: "submitted" },
    ]);
  });

  it("records the WhatsApp number the page showed, typed in place of the post's, and refuses another", async () => {
    await seedSample();
    // A kit from before applications opened with their jobs: Mark submitted opens it.
    const id = await pasted();
    await run(id, [answer(fixture("S06-number-without-country-code")), answer(DRAFT)]);
    const kit = (await jobView({ db, clock }, id))!.kitKey!;
    // The post's number has no country code: the gate holds the kit until one is typed.
    expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
      ok: false,
      reason: "held",
    });

    await cleared(id, "+1 202 555 0143");
    const shown = (await jobView({ db, clock }, id))!.handoff!.to;
    expect(shown).toBe("+1 202 555 0143");
    // Typed again on the other device: the page that showed the first number is refused.
    await recordReview({ db, clock, dns: offlineDns() }, id, {
      kind: "retype",
      value: "+1 202 555 0199",
    });
    expect(await markSubmitted({ db, clock }, id, null, { kit, to: shown })).toEqual({
      ok: false,
      reason: "changed",
    });

    expect(await markSubmitted({ db, clock }, id, null, { kit, to: "+1 202 555 0199" })).toEqual({
      ok: true,
      changed: true,
    });
    const { rows } = await db.query<{ address: string | null; status: string }>(
      "select address, status from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ address: "+1 202 555 0199", status: "submitted" }]);
  });

  it("refuses a kit whose route waits for the owner to name it", async () => {
    for (const post of ["S18-no-route", "S19-walk-in"]) {
      const { id, kit } = await readyFor(post);

      expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
        ok: false,
        reason: "not-form-or-message",
      });
    }
  });

  it("records two taps at once as one", async () => {
    // PGlite runs one transaction at a time: this shows the second tap changes nothing, not the
    // review row's lock, which Postgres holds between two at once.
    const { id, kit } = await readyFor("S16-linkedin-dm");

    const both = await Promise.all([
      markSubmitted({ db, clock }, id, null, { kit, to: "" }),
      markSubmitted({ db, clock }, id, null, { kit, to: "" }),
    ]);

    expect(both).toContainEqual({ ok: true, changed: true });
    expect(both).toContainEqual({ ok: true, changed: false });
  });

  it("takes back a Mark submitted on a kit it can no longer read, as the ledger allows", async () => {
    const { id, kit } = await readyFor("S17-form-ai-question");
    await markSubmitted({ db, clock }, id, null, { kit, to: "" });
    const submittedAt = (await jobView({ db, clock }, id))!.application!.submittedAt!;
    // As after an update: the kit's draft can no longer be read.
    await db.query(
      "update {{schema}}.job_stage_runs set output = '{}'::jsonb where job_id = $1 and stage = 'draft'",
      [id],
    );

    expect(await takeBackSubmitted({ db, clock }, id, null, submittedAt)).toEqual({ ok: true });
    expect((await jobView({ db, clock }, id))!.application?.status).toBe("kit_ready");
  });

  it("marks submitted a kit whose route the owner picked as a form", async () => {
    await seedSample();
    const id = await pasted();
    await run(
      id,
      [answer(fixture("S18-no-route")), answer(DRAFT)],
      trackApplications(pipeline(), { db, clock }),
    );
    await cleared(id);
    const kit = (await jobView({ db, clock }, id))!.kitKey!;
    expect((await jobView({ db, clock }, id))!.kitRoute).toBeNull();
    expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
      ok: false,
      reason: "not-form-or-message",
    });

    // As the owner's kit-type pick will record it.
    const { rows } = await db.query<{ id: string }>(
      "select id from {{schema}}.applications where job_id = $1",
      [id],
    );
    await setRoute({ db }, rows[0]!.id, "form");

    expect((await jobView({ db, clock }, id))!.kitRoute).toBe("form");
    expect(await markSubmitted({ db, clock }, id, null, { kit, to: "" })).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("records the post's own WhatsApp number, confirmed by its second read, as the one the message went to", async () => {
    await seedSample();
    const record = fixture("S05-whatsapp-local-number");
    record.roles[0]!.route.address = "+92 300 1234567";
    const stages = pipeline();
    const beside: Pipeline = {
      ...stages,
      draft: { ...stages.draft, alongside: () => ["address_read"] },
      address_read: addressReadStage({ db, storage, random, models: models() }),
    };
    const id = await pasted("We're hiring. Send your CV on WhatsApp: +92 300 1234567.");
    await run(id, [answer(record), answer(DRAFT)], trackApplications(beside, { db, clock }));
    await cleared(id);
    const view = (await jobView({ db, clock }, id))!;
    expect(view.handoff).toEqual({ to: "+92 300 1234567", typed: false });
    // As a number the owner typed before, which the ledger kept.
    await db.query("update {{schema}}.applications set address = $2 where job_id = $1", [
      id,
      "+1 202 555 0100",
    ]);

    expect(
      await markSubmitted({ db, clock }, id, null, { kit: view.kitKey!, to: "+92 300 1234567" }),
    ).toEqual({ ok: true, changed: true });
    const { rows } = await db.query<{ address: string | null }>(
      "select address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ address: "+92 300 1234567" }]);
  });

  it("refuses a page that named no number, as one drawn before Mark submitted named it", async () => {
    const { id, kit } = await readyFor("S17-form-ai-question");

    expect(await markSubmitted({ db, clock }, id, null, { kit, to: null })).toEqual({
      ok: false,
      reason: "changed",
    });
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
  it("counts a send left sending past its time as one that may have gone, as the job page does", async () => {
    await seedSample();
    const stuck = await pasted();
    await run(stuck, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    const sentAt = new Date(clock.now().getTime() - STUCK_MS - 1);
    await db.query(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, created_at, updated_at)
       values ($1, 'P1', 'K', 'jobs@example.com', 'sending', $2, $2, $2)`,
      [stuck, sentAt],
    );
    await db.query(
      "update {{schema}}.jobs set state = 'failed', pending_stage = 'draft', failed_stage = 'draft' where id = $1",
      [stuck],
    );

    const item = (await listJobViews({ db, clock })).find((job) => job.id === stuck)!;
    expect(item.uncertain).toBe(true);
    expect((await jobView({ db, clock }, stuck))!.uncertain).not.toBeNull();
  });

  it("names each job's route, a failed job's reason, and whether a send of its kit may have gone", async () => {
    await seedSample();
    // Reads the post, then fails to draft: the fake model has no draft to give.
    const failed = await pasted();
    await run(failed, [answer(fixture("S01-email-simple"))]);
    const picking = await pasted();
    await run(picking, [answer(fixture("S07-two-roles"))]);
    // A kit whose send may have gone, then a Gemini draft asked for beside it that failed.
    const unsure = await pasted();
    await run(unsure, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await db.query(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, created_at, updated_at)
       values ($1, 'P1', 'K', 'jobs@example.com', 'unknown', $2, $2, $2)`,
      [unsure, clock.now()],
    );
    await db.query(
      "update {{schema}}.jobs set state = 'failed', pending_stage = 'draft', failed_stage = 'draft', failure = 'Gemini could not draft it.' where id = $1",
      [unsure],
    );

    const list = await listJobViews({ db, clock });
    const item = (id: string) => list.find((job) => job.id === id)!;

    expect(item(failed)).toMatchObject({
      state: "failed",
      stateChangedAt: (await loadJob(db, failed))!.stateChangedAt,
      route: "email",
      failure: expect.any(String),
      uncertain: false,
      // No template fitted, so there are no drafts to go back to.
      backToDrafts: false,
    });
    expect(item(failed).failure).not.toBe("");
    // A post with several roles names no route until one is picked; it has not failed.
    expect(item(picking)).toMatchObject({ route: null, failure: null, uncertain: false });
    expect(item(unsure)).toMatchObject({
      state: "failed",
      failure: "Gemini could not draft it.",
      uncertain: true,
    });
  });

  it("shows a sent kit as sent, and a long-dead upload as failed", async () => {
    await seedSample();
    const sentJob = await pasted();
    await run(sentJob, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(sentJob);
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

  it("shows a ready kit the owner skipped as skipped, its job still ready", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await skipKit({ db, clock }, id, null, {
      kit: (await jobView({ db, clock }, id))!.kitKey,
      uncertain: null,
    });

    expect((await listJobViews({ db, clock })).find((job) => job.id === id)).toMatchObject({
      state: "kit_ready",
      sent: false,
      skipped: true,
    });
  });

  it("shows a form the owner marked submitted as submitted", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S17-form-ai-question")), answer(DRAFT)]);
    await cleared(id);
    await markSubmitted({ db, clock }, id, null, {
      kit: (await jobView({ db, clock }, id))!.kitKey!,
      to: "",
    });

    expect(await listJobViews({ db, clock })).toEqual([
      expect.objectContaining({ id, sent: true, submitted: true, bounced: false }),
    ]);
  });

  it("shows a sent email the owner marked bounced as bounced", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S01-email-simple")), answer(DRAFT)]);
    await cleared(id);
    await markSent({ db, clock }, id, null, { changedInGmail: false });
    const sentAt = (await jobView({ db, clock }, id))!.application!.sentAt!;
    await markBounced({ db, clock }, id, null, sentAt);

    expect(await listJobViews({ db, clock })).toEqual([
      expect.objectContaining({ id, sent: true, bounced: true, skipped: false }),
    ]);
  });

  it("shows a job a skip closed as closed, though its application was skipped with it", async () => {
    await seedSample();
    const id = await pasted();
    await run(id, [answer(fixture("S02-us-only"))], trackApplications(pipeline(), { db, clock }));
    expect((await jobView({ db, clock }, id))!.state).toBe("needs_eligibility_decision");
    await skipJob({ db, clock }, id);
    await skippedForJob({ db, clock }, id, null);

    expect((await listJobViews({ db, clock })).find((job) => job.id === id)).toMatchObject({
      state: "closed",
      skipped: false,
    });
  });
});
