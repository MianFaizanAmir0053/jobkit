import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { DraftAnswer } from "@/core/drafting/kit";
import { startJob } from "@/core/intake/jobs";
import type { Dns } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import type { GateReason } from "./canHandOff";
import { flagKey, NO_DECISIONS } from "./decisions";
import { jobView, storedDecisions } from "./jobView";
import { applyAgainForJob, recordReview } from "./kitReview";
import { markSent, takeBackSent } from "./markSent";
import { KIT_DRAFT, readyKit as kitFor, resetKitBed } from "./testKit";

/* The owner's decisions on a kit, kept with the gate they leave: review AC1 and AC4. */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

/** The draft, its one sentence citing a fact the profile does not hold. */
const CITING_NOTHING: DraftAnswer = {
  ...KIT_DRAFT,
  blocks: [{ ...KIT_DRAFT.blocks[0]!, fact_ids: ["F-not-in-the-profile"] }],
};

/** A DNS where these domains take mail, and no other does. */
const mailOnly = (domains: readonly string[]): Dns => ({
  async lookup(name, type) {
    return type === "MX" && domains.includes(name)
      ? { kind: "records", values: [`mx.${name}`] }
      : { kind: "none" };
  },
});

const deps = (dns: Dns = offlineDns()) => ({ db, clock, dns });

/** A job run to its kit, its post pasted with `text`, the judge calling S1 overstated. */
const readyKit = (text: string, opts?: Parameters<typeof kitFor>[2]) =>
  kitFor({ db, clock, storage }, text, opts);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-review-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
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
        meets: [],
        edits: {},
        confirmed: [],
      },
      gate: typed.ok ? typed.gate : [],
    });
    expect(view.handoff).toEqual({ to: "jobs@example.com", typed: true });
  });

  it("keeps the owner's words for a sentence, holds them until confirmed, and takes them back", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const block = (await jobView({ db, clock }, id))!.draft!.kit.blocks[0]!;
    const words = "I have built production React applications for four years.";

    const edited = await recordReview(deps(), id, { kind: "edit", blockId: block.id, text: words });

    expect(edited.ok && edited.gate.map((reason) => reason.kind)).toContain("unconfirmed_edit");
    const after = (await jobView({ db, clock }, id))!;
    expect(after.kit!.blocks[0]!.text).toBe(words);
    // The draft stays as drafted.
    expect(after.draft!.kit.blocks[0]!.text).toBe(block.text);
    const confirmed = await recordReview(deps(), id, { kind: "confirm", blockId: block.id });
    expect(confirmed.ok && confirmed.gate.map((reason) => reason.kind)).not.toContain(
      "unconfirmed_edit",
    );
    // Written back as drafted: no edit at all.
    await recordReview(deps(), id, { kind: "edit", blockId: block.id, text: block.text });
    expect((await jobView({ db, clock }, id))!.review!.decisions).toMatchObject({
      edits: {},
      confirmed: [],
    });
    // A sentence the kit has not, or a confirmation of no edit, is refused.
    expect(await recordReview(deps(), id, { kind: "edit", blockId: "S99", text: "x" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
    expect(await recordReview(deps(), id, { kind: "confirm", blockId: block.id })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
  });

  it("runs validate again on the email as the owner edited it", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const block = (await jobView({ db, clock }, id))!.draft!.kit.blocks[0]!;
    const kinds = async () =>
      (await jobView({ db, clock }, id))!.kitParts!.flags.map((flag) => flag.kind);
    expect(await kinds()).not.toContain("over_limit");

    await recordReview(deps(), id, {
      kind: "edit",
      blockId: block.id,
      text: `${Array.from({ length: 200 }, () => "React").join(" ")}.`,
    });
    expect(await kinds()).toContain("over_limit");

    await recordReview(deps(), id, { kind: "revert", blockId: block.id });
    expect(await kinds()).not.toContain("over_limit");
  });

  it("reads a decision kept by a flag's place, from before flags were named, as that flag's", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      draft: CITING_NOTHING,
    });
    const view = (await jobView({ db, clock }, id))!;
    const place = view.kitParts!.flags.findIndex((each) => each.kind === "invalid_citation");
    // As the page kept it before: the flag's place among drafting's, from 1.
    await db.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, $2, $3::jsonb, '[]'::jsonb, $4)
       on conflict (job_id, role_id) do update set decisions = excluded.decisions`,
      [
        id,
        view.role!.id,
        storedDecisions(view.kitKey!, { ...NO_DECISIONS, flagsChecked: [`F${place + 1}`] }),
        clock.now(),
      ],
    );

    const read = (await jobView({ db, clock }, id))!;

    expect(read.review!.decisions.flagsChecked).toEqual([flagKey(view.kitParts!.flags[place]!)]);
    expect(
      read.review!.gate.some(
        (reason) => reason.kind === "flag" && reason.flag.kind === "invalid_citation",
      ),
    ).toBe(false);
  });

  it('clears each of validate\'s flags with "I checked this", and only a flag the kit has', async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      draft: CITING_NOTHING,
    });
    const view = (await jobView({ db, clock }, id))!;
    const citation = view.kitParts!.flags.find((each) => each.kind === "invalid_citation")!;
    const open = (gate: readonly GateReason[]) =>
      gate.some((reason) => reason.kind === "flag" && reason.flag.kind === "invalid_citation");
    expect(open(view.review!.gate)).toBe(true);

    const checked = await recordReview(deps(), id, {
      kind: "check_flag",
      flag: flagKey(citation),
    });

    expect(checked.ok && open(checked.gate)).toBe(false);
    expect(
      await recordReview(deps(), id, { kind: "check_flag", flag: "over_limit@body~00000000" }),
    ).toEqual({
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

  it('takes the owner\'s word that they meet a requirement only they can confirm, apart from "I checked this"', async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      // A language the draft marks met: only the owner can confirm it.
      record: (record) => {
        const role = record.roles[0]!;
        role.requirements[3] = {
          ...role.requirements[3]!,
          kind: "language",
          text: "Fluent English",
          skills: [],
        };
        return record;
      },
      draft: {
        ...KIT_DRAFT,
        fit: KIT_DRAFT.fit.map((row) =>
          row.requirement_id === "R4" ? { ...row, verdict: "met" as const } : row,
        ),
      },
    });
    const meetable = (await jobView({ db, clock }, id))!.review!.gate.filter(
      (reason) => reason.kind === "flag" && reason.flag.at === "R4",
    );
    expect(meetable).toHaveLength(1);

    const said = await recordReview(deps(), id, {
      kind: "meets",
      requirementId: "R4",
      ticked: true,
    });

    expect(
      said.ok && said.gate.filter((reason) => reason.kind === "flag" && reason.flag.at === "R4"),
    ).toEqual([]);
    const view = (await jobView({ db, clock }, id))!;
    expect(view.review?.decisions.meets).toEqual(["R4"]);
    expect(view.review?.decisions.flagsChecked).toEqual([]);
    // A requirement the owner's word does not settle takes none, though withdrawing one always
    // goes, as one carried by a pick to a draft whose row takes no tick.
    expect(
      await recordReview(deps(), id, { kind: "meets", requirementId: "R1", ticked: true }),
    ).toEqual({ ok: false, reason: "not-in-kit" });
    expect(
      await recordReview(deps(), id, { kind: "meets", requirementId: "R1", ticked: false }),
    ).toMatchObject({ ok: true });
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
      { kind: "check_flag", flag: "over_limit@body~00000000" },
      { kind: "meets", requirementId: "R1", ticked: true },
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
