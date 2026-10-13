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
import type { Dns } from "@/core/ports";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import { addressChecksStage } from "./addressChecksStage";
import type { GateReason } from "./canHandOff";
import { flagKey, NO_DECISIONS } from "./decisions";
import { jobView, storedDecisions } from "./jobView";
import { applyAgainForJob, recordReview } from "./kitReview";
import { markSent, takeBackSent } from "./markSent";

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

/** The draft, its one sentence citing a fact the profile does not hold. */
const CITING_NOTHING: DraftAnswer = {
  ...DRAFT,
  blocks: [{ ...DRAFT.blocks[0]!, fact_ids: ["F-not-in-the-profile"] }],
};

/** A DNS where these domains take mail, and no other does. */
const mailOnly = (domains: readonly string[]): Dns => ({
  async lookup(name, type) {
    return type === "MX" && domains.includes(name)
      ? { kind: "records", values: [`mx.${name}`] }
      : { kind: "none" };
  },
});

/** The judge, as a stage that gives these verdicts on the kit; or the output of a kit from before it was built. */
const judging = (verdicts: BlockVerdict[] | "before the judge") => ({
  callsModel: false,
  input: () => ({}),
  run: async () => ({
    ok: true as const,
    output:
      verdicts === "before the judge"
        ? { checked: false }
        : { checked: true, verdicts, markers: [] },
  }),
  next: () => ({ state: "kit_ready" as const, pending: null }),
});

const deps = (dns: Dns = offlineDns()) => ({ db, clock, dns });

/** A job run to its kit, its post pasted with `text`, the judge calling S1 overstated. */
async function readyKit(
  text: string,
  opts: {
    draft?: DraftAnswer;
    dns?: Dns;
    verdicts?: BlockVerdict[] | "before the judge";
  } = {},
): Promise<string> {
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: text, clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  const record = JSON.parse(
    readFileSync(join(SYNTHETIC, "records", "S01-email-simple.json"), "utf8"),
  ) as JobRecord;
  llm = fakeLlm([answer(record), answer(opts.draft ?? DRAFT)]);
  const pipeline: Pipeline = {
    extract: extractStage({ db, storage, random, models: models() }),
    eligibility: eligibilityStage({ db, clock }),
    draft: {
      ...draftStage({ db, random, models: models() }),
      alongside: () => ["address_read", "address_checks"],
    },
    address_read: addressReadStage({ db, storage, random, models: models() }),
    address_checks: addressChecksStage({ db, dns: opts.dns ?? offlineDns() }),
    judge: judging(
      opts.verdicts ?? [
        { blockId: "S1", verdict: "overstated", companyClaim: false, note: "Five years is more." },
      ],
    ),
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
    `delete from {{schema}}.kit_reviews; delete from {{schema}}.status_changes;
     delete from {{schema}}.draft_outcomes; delete from {{schema}}.applications;
     delete from {{schema}}.model_calls;
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

    const checked = await recordReview(deps(), id, { kind: "check", blockId: "S1" });
    expect(checked.ok && kinds(checked.gate)).toEqual(["contact"]);

    const typed = await recordReview(deps(), id, {
      kind: "retype",
      value: "jobs@example.com",
    });
    expect(typed.ok && kinds(typed.gate)).toEqual([]);

    const view = (await jobView({ db, clock }, id))!;
    expect(view.review).toEqual({
      decisions: {
        checked: ["S1"],
        flagsChecked: [],
        retyped: { value: "jobs@example.com", checks: expect.any(Array) },
        attached: [],
        continueAnyway: false,
        lookups: expect.any(Array),
      },
      gate: typed.ok ? typed.gate : [],
    });
    expect(view.handoff).toEqual({ to: "jobs@example.com", typed: true });
  });

  it('clears each of validate\'s flags with "I checked this", and only a flag the kit has', async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      draft: CITING_NOTHING,
    });
    const view = (await jobView({ db, clock }, id))!;
    const place = view.kitParts!.flags.findIndex((each) => each.kind === "invalid_citation");
    const open = (gate: readonly GateReason[]) =>
      gate.some((reason) => reason.kind === "flag" && reason.flag.kind === "invalid_citation");
    expect(open(view.review!.gate)).toBe(true);

    const checked = await recordReview(deps(), id, { kind: "check_flag", flag: flagKey(place) });

    expect(checked.ok && open(checked.gate)).toBe(false);
    expect(await recordReview(deps(), id, { kind: "check_flag", flag: "F99" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
  });

  it("checks an address the owner types, which then stands in for the post's, checks and all", async () => {
    // The post's domain takes no mail: its address holds the kit until the owner types one.
    const dns = mailOnly(["northwind-careers.com"]);
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", { dns });
    const before = (await jobView({ db, clock }, id))!;
    expect(before.kitParts!.contact).toEqual({ kind: "email", needsRetype: true });
    expect(kinds(before.review!.gate)).toEqual(["contact", "judge"]);

    const dead = await recordReview(deps(dns), id, {
      kind: "retype",
      value: "jobs@nomail-northwind.com",
    });
    expect(dead.ok && kinds(dead.gate)).toEqual(["address_check", "judge"]);

    const typed = await recordReview(deps(dns), id, {
      kind: "retype",
      value: "jobs@northwind-careers.com",
    });
    expect(typed.ok && kinds(typed.gate)).toEqual(["judge"]);
    expect((await jobView({ db, clock }, id))!.handoff).toEqual({
      to: "jobs@northwind-careers.com",
      typed: true,
    });
  });

  it("keeps the first checks of an address typed, so typing it again while DNS fails changes nothing", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");
    const dead = await recordReview(deps(mailOnly([])), id, {
      kind: "retype",
      value: "jobs@nomail-northwind.com",
    });
    expect(dead.ok && kinds(dead.gate)).toEqual(["address_check", "judge"]);
    const timingOut: Dns = { lookup: async () => ({ kind: "timeout" }) };

    const again = await recordReview(deps(timingOut), id, {
      kind: "retype",
      value: "jobs@nomail-northwind.com",
    });
    // An address's case changes nothing about where it goes.
    const shouted = await recordReview(deps(timingOut), id, {
      kind: "retype",
      value: "JOBS@NoMail-Northwind.com",
    });

    expect(again.ok && kinds(again.gate)).toEqual(["address_check", "judge"]);
    expect(shouted.ok && kinds(shouted.gate)).toEqual(["address_check", "judge"]);
  });

  it("keeps what the address checks found for the post's own address, when the owner types it again", async () => {
    // The post's domain takes no mail, which holds its address until the owner types one.
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      dns: mailOnly([]),
    });
    const timingOut: Dns = { lookup: async () => ({ kind: "timeout" }) };

    const typed = await recordReview(deps(timingOut), id, {
      kind: "retype",
      value: "Jobs@Example.com",
    });

    expect(typed.ok && kinds(typed.gate)).toEqual(["address_check", "judge"]);
  });

  it("keeps the address the owner typed once it passes, even where the kit would no longer ask for it", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const { kitKey, role } = (await jobView({ db, clock }, id))!;
    // Typed while an earlier version of jobkit doubted the post's address.
    await db.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, $2, $3::jsonb, '[]'::jsonb, $4)`,
      [
        id,
        role!.id,
        storedDecisions(kitKey!, {
          ...NO_DECISIONS,
          retyped: { value: "careers@example.com", checks: [] },
        }),
        clock.now(),
      ],
    );

    const view = (await jobView({ db, clock }, id))!;

    expect(view.handoff).toEqual({ to: "careers@example.com", typed: true });
    expect(view.kitParts!.contact).toEqual({ kind: "email", needsRetype: true });
  });

  it("refuses a decision made on another kit than the one that stands", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const { kitKey } = (await jobView({ db, clock }, id))!;

    expect(
      await recordReview(deps(), id, { kind: "check", blockId: "S1" }, { kit: "another kit" }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await recordReview(deps(), id, { kind: "check", blockId: "S1" }, { kit: kitKey! }),
    ).toMatchObject({ ok: true });
    expect(await applyAgainForJob({ db, clock }, id, ["x"], { kit: "another kit" })).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  it("refuses Mark sent while anything holds the kit, and takes back a mistaken tap", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toEqual({
      ok: false,
      reason: "held",
    });
    await recordReview(deps(), id, { kind: "check", blockId: "S1" });
    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });

    expect(await takeBackSent({ db, clock }, id, null)).toEqual({ ok: true });

    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual([]);
    expect(await takeBackSent({ db, clock }, id, null)).toEqual({ ok: false, reason: "not-sent" });
  });

  it("refuses a Mark sent from a page drawn on another kit, or showing another address", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");
    await recordReview(deps(), id, { kind: "check", blockId: "S1" });
    await recordReview(deps(), id, { kind: "retype", value: "jobs@example.com" });
    const { kitKey } = (await jobView({ db, clock }, id))!;
    // On the phone, the owner types the address again after this page was drawn.
    await recordReview(deps(), id, { kind: "retype", value: "careers@example.com" });
    const no = { changedInGmail: false };

    expect(
      await markSent({ db, clock }, id, null, no, { kit: kitKey!, to: "jobs@example.com" }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await markSent({ db, clock }, id, null, no, {
        kit: "another kit",
        to: "careers@example.com",
      }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await markSent({ db, clock }, id, null, no, { kit: kitKey!, to: "careers@example.com" }),
    ).toMatchObject({ ok: true });
  });

  it("takes back only the Mark sent the page showed, so a late tap leaves a later one", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await recordReview(deps(), id, { kind: "check", blockId: "S1" });
    await markSent({ db, clock }, id, null, { changedInGmail: false });
    const first = (await jobView({ db, clock }, id))!.application!.sentAt!;
    expect(await takeBackSent({ db, clock }, id, null, first)).toEqual({ ok: true });
    clock.advance(60_000);
    await markSent({ db, clock }, id, null, { changedInGmail: false });

    // A page still showing the first Mark sent is tapped late.
    expect(await takeBackSent({ db, clock }, id, null, first)).toEqual({
      ok: false,
      reason: "not-sent",
    });
    expect((await jobView({ db, clock }, id))!.application!.status).toBe("sent");
  });

  it("records an address the owner typed as an edit, unless it is the one jobkit read", async () => {
    const outcome = async (typed: string) => {
      // No earlier application of the same post to hold the kit as a duplicate.
      await db.exec(
        `delete from {{schema}}.draft_outcomes; delete from {{schema}}.status_changes;
         delete from {{schema}}.applications`,
      );
      // The post's address cannot be read again from it, so the owner types it.
      const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");
      await recordReview(deps(), id, { kind: "check", blockId: "S1" });
      await recordReview(deps(), id, { kind: "retype", value: typed });
      await markSent({ db, clock }, id, null, { changedInGmail: false });
      const { rows } = await db.query<{ changed: string[]; factual_edit: boolean }>(
        "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
        [id],
      );
      return rows;
    };

    expect(await outcome("careers@example.com")).toEqual([
      { changed: ["address"], factual_edit: true },
    ]);
    // The record read jobs@example.com: typed again, it changes nothing.
    expect(await outcome("Jobs@Example.com")).toEqual([{ changed: [], factual_edit: false }]);
  });

  it("keeps decisions only for the kit they were made on", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await recordReview(deps(), id, { kind: "check", blockId: "S1" });
    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual([]);

    // The kit is drafted again: its S1 is another sentence now.
    await db.query(
      `update {{schema}}.job_stage_runs set output_hash = 'drafted again'
        where job_id = $1 and stage = 'draft'`,
      [id],
    );

    const after = (await jobView({ db, clock }, id))!;
    expect(after.review!.decisions).toEqual(NO_DECISIONS);
    expect(kinds(after.review!.gate)).toEqual(["judge"]);
  });

  it("holds everything once the kit is marked sent, and takes no more decisions", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    await recordReview(deps(), id, { kind: "check", blockId: "S1" });

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });

    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual(["sent"]);
    expect(await recordReview(deps(), id, { kind: "uncheck", blockId: "S1" })).toEqual({
      ok: false,
      reason: "sent",
    });
  });

  it("holds every sentence of a kit the separate check never weighed", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      verdicts: "before the judge",
    });

    expect((await jobView({ db, clock }, id))!.review!.gate).toEqual([
      expect.objectContaining({ kind: "judge", blockId: "S1", verdict: "unsupported" }),
    ]);
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
      { kind: "attach", id: "A1", ticked: true },
      { kind: "continue_anyway" },
      { kind: "retype", value: "other@example.com" },
      { kind: "check_flag", flag: "F1" },
    ] as const) {
      expect(await recordReview(deps(), id, action), action.kind).toEqual({
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

    expect(await recordReview(deps(), started.jobId, { kind: "continue_anyway" })).toEqual({
      ok: false,
      reason: "not-ready",
    });
    expect(
      await recordReview(deps(), "00000000-0000-4000-8000-000000000000", {
        kind: "continue_anyway",
      }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("keeps both of two decisions made at once", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");

    await Promise.all([
      recordReview(deps(), id, { kind: "check", blockId: "S1" }),
      recordReview(deps(), id, { kind: "retype", value: "jobs@example.com" }),
    ]);

    expect((await jobView({ db, clock }, id))!.review!.decisions).toMatchObject({
      checked: ["S1"],
      retyped: { value: "jobs@example.com" },
    });
  });
});
