import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { asEmailKit, type DraftAnswer } from "@/core/drafting/kit";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import type { Dns } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import type { GateReason } from "./canHandOff";
import { flagKey, NO_DECISIONS } from "./decisions";
import { pickDraft } from "./draftChoice";
import { jobView, storedDecisions } from "./jobView";
import { applyAgainForJob, recordReview } from "./kitReview";
import { markSent, recordHandoff, takeBackSent } from "./markSent";
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

/** The post asks for Kubernetes in production too, a must-have the owner's profile says they lack. */
const askingForKubernetes = (record: JobRecord): JobRecord => ({
  ...record,
  roles: record.roles.map((role) => ({
    ...role,
    requirements: [
      ...role.requirements,
      {
        id: "R5",
        text: "Kubernetes in production",
        priority: "must",
        kind: "skill",
        skills: ["kubernetes"],
        depth: "production",
        years: -1,
      },
    ],
  })),
});

/** The draft, with the profile's known line about Kubernetes as its gap line. */
const WITH_GAP_LINE: DraftAnswer = {
  fit: [...KIT_DRAFT.fit, { requirement_id: "R5", verdict: "gap", fact_ids: [], note: "" }],
  blocks: [
    ...KIT_DRAFT.blocks,
    {
      id: "S2",
      text: "",
      paragraph_break: true,
      class: "gap",
      fact_ids: [],
      fields: [],
      gap: {
        requirement_id: "R5",
        known_line_id: "K-kubernetes",
        template_id: "",
        related_fact_id: "",
      },
    },
  ],
};

/** Fluent German as a must-have only the owner can confirm, the drafter calling it met. */
const askingForGerman = (record: JobRecord): JobRecord => ({
  ...record,
  roles: record.roles.map((role) => ({
    ...role,
    requirements: [
      ...role.requirements,
      {
        id: "R5",
        text: "Fluent German",
        priority: "must",
        kind: "language",
        skills: [],
        depth: "any",
        years: -1,
      },
    ],
  })),
});

const NO_GAP = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };

/** The draft with a second sentence, and the fit table given. */
const withSecond = (
  second: DraftAnswer["blocks"][number],
  fit: DraftAnswer["fit"] = KIT_DRAFT.fit,
): DraftAnswer => ({ ...KIT_DRAFT, fit, blocks: [...KIT_DRAFT.blocks, second] });

/** S2: the drafter's line about German, a must-have it called met. */
const WITH_GERMAN_LINE = withSecond(
  {
    id: "S2",
    text: "I am learning German at B1 level.",
    paragraph_break: false,
    class: "gap",
    fact_ids: [],
    fields: [],
    gap: { ...NO_GAP, requirement_id: "R5" },
  },
  [...KIT_DRAFT.fit, { requirement_id: "R5", verdict: "met", fact_ids: [], note: "" }],
);

/** The post sent with an address; its record carries a subject format, which drafting applies. */
const POSTED = "Northwind Analytics is hiring. Apply to jobs@example.com.";
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
        added: [],
        deleted: [],
        answers: {},
        declined: [],
        choices: {},
        handoff: null,
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

  it("adds the owner's sentence, held until they confirm it, and deletes a drafted one, which holds nothing", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual(["judge"]);
    const words = "I lead code reviews for a team of four.";

    const added = await recordReview(deps(), id, { kind: "add", after: "S1", text: words });

    expect(added.ok && kinds(added.gate)).toEqual(["judge", "unconfirmed_edit"]);
    expect((await jobView({ db, clock }, id))!.kit!.blocks.map((block) => block.id)).toEqual([
      "S1",
      "N1",
    ]);
    await recordReview(deps(), id, { kind: "confirm", blockId: "N1" });
    // S1, which the separate check holds, deleted: nothing holds the email, and S1 is not in it.
    const deleted = await recordReview(deps(), id, { kind: "delete", blockId: "S1" });
    expect(deleted.ok && kinds(deleted.gate)).toEqual([]);
    expect((await jobView({ db, clock }, id))!.kit!.blocks.map((block) => block.text)).toEqual([
      words,
    ]);
    // A deleted sentence is not edited until the deletion is taken back, which holds the email again.
    expect(await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: "x" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
    const back = await recordReview(deps(), id, { kind: "revert", blockId: "S1" });
    expect(back.ok && kinds(back.gate)).toEqual(["judge"]);
    // After a sentence the kit has not, or a confirmation of drafting's words: refused.
    expect(await recordReview(deps(), id, { kind: "add", after: "S9", text: "x" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
    expect(await recordReview(deps(), id, { kind: "confirm", blockId: "S1" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
  });

  it("asks for a line about a must-have once the owner deletes its gap line (drafting AC13)", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      record: askingForKubernetes,
      draft: WITH_GAP_LINE,
    });
    const view = (await jobView({ db, clock }, id))!;
    const gap = view.kit!.blocks.find((block) => block.class === "gap")!;
    expect(gap.text).toContain("Kubernetes");
    expect(view.kitParts!.flags.map((flag) => flag.kind)).not.toContain("missing_gap_line");

    await recordReview(deps(), id, { kind: "delete", blockId: gap.id });

    const flags = (await jobView({ db, clock }, id))!.kitParts!.flags;
    expect(flags.map((flag) => [flag.kind, flag.at])).toContainEqual(["missing_gap_line", "R5"]);
  });

  it("takes a sentence of the owner's, marked as answering a must-have, as its line (drafting AC13)", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      record: askingForKubernetes,
    });
    const missing = async () =>
      (await jobView({ db, clock }, id))!.kitParts!.flags.some(
        (flag) => flag.kind === "missing_gap_line" && flag.at === "R5",
      );
    expect(await missing()).toBe(true);
    await recordReview(deps(), id, {
      kind: "add",
      after: "S1",
      text: "I have not run Kubernetes in production; I deploy containers with Docker.",
    });
    expect(await missing()).toBe(true);

    await recordReview(deps(), id, { kind: "answers", blockId: "N1", requirementId: "R5" });

    expect(await missing()).toBe(false);
    // A requirement the post does not ask for as a must-have, or drafting's own words: refused.
    expect(
      await recordReview(deps(), id, { kind: "answers", blockId: "N1", requirementId: "R4" }),
    ).toEqual({ ok: false, reason: "not-in-kit" });
    expect(
      await recordReview(deps(), id, { kind: "answers", blockId: "S1", requirementId: "R5" }),
    ).toEqual({ ok: false, reason: "not-in-kit" });
    await recordReview(deps(), id, { kind: "answers", blockId: "N1", requirementId: "" });
    expect(await missing()).toBe(true);
  });

  it("refuses a decision from a page that showed other words, as one drawn before an edit on the other device", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const shown = (await jobView({ db, clock }, id))!;
    await recordReview(deps(), id, {
      kind: "edit",
      blockId: "S1",
      text: "I have built production React applications for nine years.",
    });

    // The page drawn before shows the drafted words: neither its Confirm nor its check of S1 counts.
    const made = { kit: shown.kitKey!, words: shown.wordsKey! };
    expect(await recordReview(deps(), id, { kind: "confirm", blockId: "S1" }, made)).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(await recordReview(deps(), id, { kind: "check", blockId: "S1" }, made)).toEqual({
      ok: false,
      reason: "changed",
    });
    const now = (await jobView({ db, clock }, id))!;
    const confirmed = await recordReview(
      deps(),
      id,
      { kind: "confirm", blockId: "S1" },
      { kit: now.kitKey!, words: now.wordsKey! },
    );
    expect(confirmed.ok).toBe(true);
  });

  it("takes back the check on a must-have when its line is rewritten, which weighed the old words", async () => {
    // Fluent German, a must-have only the owner can confirm, marked met by the drafter.
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      record: (record) => ({
        ...record,
        roles: record.roles.map((role) => ({
          ...role,
          requirements: [
            ...role.requirements,
            {
              id: "R5",
              text: "Fluent German",
              priority: "must",
              kind: "language",
              skills: [],
              depth: "any",
              years: -1,
            },
          ],
        })),
      }),
      draft: {
        ...KIT_DRAFT,
        fit: [...KIT_DRAFT.fit, { requirement_id: "R5", verdict: "met", fact_ids: [], note: "" }],
      },
      verdicts: [{ blockId: "S1", verdict: "supported", companyClaim: false, note: "" }],
    });
    const germanFlag = async () =>
      flagKey(
        (await jobView({ db, clock }, id))!.kitParts!.flags.find(
          (flag) => flag.kind === "fit_unverified" && flag.at === "R5",
        )!,
      );
    // The owner does not speak German: their line says so, confirmed, and the flag checked.
    await recordReview(deps(), id, { kind: "add", after: "S1", text: "I do not speak German." });
    await recordReview(deps(), id, { kind: "answers", blockId: "N1", requirementId: "R5" });
    await recordReview(deps(), id, { kind: "confirm", blockId: "N1" });
    await recordReview(deps(), id, { kind: "check_flag", flag: await germanFlag() });
    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual([]);

    await recordReview(deps(), id, { kind: "edit", blockId: "N1", text: "I am fluent in German." });
    await recordReview(deps(), id, { kind: "confirm", blockId: "N1" });

    const after = (await jobView({ db, clock }, id))!;
    expect(after.review!.decisions.flagsChecked).not.toContain(await germanFlag());
    expect(kinds(after.review!.gate)).toEqual(["flag"]);

    // Checked again, then the line deleted: the check weighed the email with it, and goes.
    await recordReview(deps(), id, { kind: "check_flag", flag: await germanFlag() });
    await recordReview(deps(), id, { kind: "delete", blockId: "N1" });
    expect((await jobView({ db, clock }, id))!.review!.decisions.flagsChecked).not.toContain(
      await germanFlag(),
    );
  });

  it("takes back a check on a must-have when Undo delete brings back a line about it", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      record: askingForGerman,
      draft: withSecond(
        {
          id: "S2",
          text: "Thank you for considering my application.",
          paragraph_break: false,
          class: "courtesy",
          fact_ids: [],
          fields: [],
          gap: NO_GAP,
        },
        [...KIT_DRAFT.fit, { requirement_id: "R5", verdict: "met", fact_ids: [], note: "" }],
      ),
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "S2", verdict: "not_a_claim", companyClaim: false, note: "" },
      ],
    });
    const german = async () =>
      flagKey(
        (await jobView({ db, clock }, id))!.kitParts!.flags.find(
          (flag) => flag.kind === "fit_unverified" && flag.at === "R5",
        )!,
      );
    const checked = async () =>
      (await jobView({ db, clock }, id))!.review!.decisions.flagsChecked.includes(await german());
    // The owner's line about German in place of the courtesy sentence, then deleted.
    await recordReview(deps(), id, { kind: "edit", blockId: "S2", text: "I am fluent in German." });
    await recordReview(deps(), id, { kind: "answers", blockId: "S2", requirementId: "R5" });
    await recordReview(deps(), id, { kind: "confirm", blockId: "S2" });
    await recordReview(deps(), id, { kind: "delete", blockId: "S2" });
    // Checked while the email says nothing about German.
    await recordReview(deps(), id, { kind: "check_flag", flag: await german() });
    expect(await checked()).toBe(true);

    await recordReview(deps(), id, { kind: "revert", blockId: "S2" });

    expect(await checked()).toBe(false);
    expect(kinds((await jobView({ db, clock }, id))!.review!.gate)).toEqual(["flag"]);
  });

  it("takes back a check on a must-have its drafted line answered, when the owner marks the line as answering none", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      record: askingForGerman,
      draft: WITH_GERMAN_LINE,
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "S2", verdict: "supported", companyClaim: false, note: "" },
      ],
    });
    const german = async () =>
      flagKey(
        (await jobView({ db, clock }, id))!.kitParts!.flags.find(
          (flag) => flag.kind === "fit_unverified" && flag.at === "R5",
        )!,
      );
    const checked = async () =>
      (await jobView({ db, clock }, id))!.review!.decisions.flagsChecked.includes(await german());
    await recordReview(deps(), id, { kind: "edit", blockId: "S2", text: "I speak fluent German." });
    await recordReview(deps(), id, { kind: "confirm", blockId: "S2" });
    await recordReview(deps(), id, { kind: "check_flag", flag: await german() });
    expect(await checked()).toBe(true);

    // The rewritten line answers no must-have now: the check weighed it as German's line.
    await recordReview(deps(), id, {
      kind: "answers",
      blockId: "S2",
      requirementId: "",
      was: "R5",
    });
    expect(await checked()).toBe(false);

    // Checked again with no line about German, then Undo edit brings drafting's line back.
    await recordReview(deps(), id, { kind: "check_flag", flag: await german() });
    await recordReview(deps(), id, { kind: "revert", blockId: "S2" });
    expect(await checked()).toBe(false);
  });

  it("refuses a choice from a page that showed another, though the words are the same", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.", {
      record: askingForKubernetes,
    });
    await recordReview(deps(), id, {
      kind: "add",
      after: "S1",
      text: "I have not run Kubernetes in production; I deploy containers with Docker.",
    });
    // The laptop marks the sentence as the line about R5 and types the address; the phone's page
    // was drawn before, showing none of it.
    await recordReview(deps(), id, {
      kind: "answers",
      blockId: "N1",
      requirementId: "R5",
      was: "",
    });
    await recordReview(deps(), id, { kind: "retype", value: "jobs@example.com", was: "" });
    const shown = (await jobView({ db, clock }, id))!;
    const made = { kit: shown.kitKey!, words: shown.wordsKey! };

    expect(
      await recordReview(
        deps(),
        id,
        { kind: "answers", blockId: "N1", requirementId: "", was: "" },
        made,
      ),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await recordReview(deps(), id, { kind: "retype", value: "hr@example.com", was: "" }, made),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await recordReview(
        deps(),
        id,
        { kind: "decline", instruction: "keyword", declined: false, was: true },
        made,
      ),
    ).toEqual({ ok: false, reason: "changed" });
    const after = (await jobView({ db, clock }, id))!.review!.decisions;
    expect(after.answers).toEqual({ N1: "R5" });
    expect(after.retyped?.value).toBe("jobs@example.com");
    // Named as it stands, each is taken.
    const changed = await recordReview(
      deps(),
      id,
      { kind: "answers", blockId: "N1", requirementId: "", was: "R5" },
      made,
    );
    expect(changed.ok).toBe(true);
  });

  it("forgets a check on a flag the email no longer has, so the flag never comes back checked", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    // The only claim says nothing: the email says nothing about the owner, which they check.
    await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: "—" });
    const flag = (await jobView({ db, clock }, id))!.kitParts!.flags.find(
      (each) => each.kind === "no_claims",
    )!;
    await recordReview(deps(), id, { kind: "check_flag", flag: flagKey(flag) });

    // The words back, and the flag gone: its check goes too.
    await recordReview(deps(), id, { kind: "revert", blockId: "S1" });
    expect((await jobView({ db, clock }, id))!.review!.decisions.flagsChecked).toEqual([]);
    const again = await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: "—" });
    expect(
      again.ok &&
        again.gate.some((reason) => reason.kind === "flag" && reason.flag.kind === "no_claims"),
    ).toBe(true);
  });

  it("records an edit of a sentence about the post as factual only when it changes the company's or the role's name", async () => {
    const outcome = async (text: string) => {
      // Each job alone, so neither is the other's duplicate.
      await resetKitBed({ db, clock, storage });
      const id = await readyKit(`${text} Apply to jobs@example.com.`, { templates: true });
      const opener = (await jobView({ db, clock }, id))!.kit!.blocks.find(
        (block) => block.class === "post",
      )!;
      await recordReview(deps(), id, { kind: "edit", blockId: opener.id, text });
      await recordReview(deps(), id, { kind: "confirm", blockId: opener.id });
      expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
        ok: true,
      });
      const { rows } = await db.query<{ factual_edit: boolean }>(
        "select factual_edit from {{schema}}.draft_outcomes where job_id = $1",
        [id],
      );
      return rows[0]!.factual_edit;
    };

    expect(
      await outcome(
        "I am applying for the Senior Full-Stack Engineer role at Northwind Analytics.",
      ),
    ).toBe(false);
    expect(await outcome("I am applying for the engineering role at Northwind.")).toBe(true);
  });

  it("declines the post's subject format, word limit and keyword: the subject falls back, and the flags they caused clear (review AC4)", async () => {
    const asking = (record: JobRecord): JobRecord => ({
      ...record,
      roles: record.roles.map((role) => ({
        ...role,
        instructions: [
          ...role.instructions,
          {
            kind: "word_limit",
            text: "Keep it under 5 words.",
            value: "5",
            addressed_to_ai: false,
          },
          {
            kind: "include_keyword",
            text: "Mention Kubernetes.",
            value: "Kubernetes",
            addressed_to_ai: false,
          },
        ],
      })),
    });
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      record: asking,
      verdicts: [{ blockId: "S1", verdict: "supported", companyClaim: false, note: "" }],
    });
    const shown = async () => (await jobView({ db, clock }, id))!;
    const drafted = await shown();
    expect(drafted.kitParts!.flags.map((flag) => flag.kind)).toEqual(
      expect.arrayContaining(["over_limit", "keyword_missing"]),
    );
    expect(asEmailKit(drafted.kit!).subject).toBe(
      "Application - Senior Full-Stack Engineer - Sam Rivera",
    );

    for (const instruction of ["word_limit", "keyword", "subject_format"] as const) {
      await recordReview(deps(), id, { kind: "decline", instruction, declined: true });
    }

    const declined = await shown();
    expect(declined.kitParts!.flags.map((flag) => flag.kind)).not.toContain("over_limit");
    expect(declined.kitParts!.flags.map((flag) => flag.kind)).not.toContain("keyword_missing");
    expect(asEmailKit(declined.kit!).subject).toBe(
      "Application: Senior Full-Stack Engineer – Sam Rivera",
    );
    // Taken back: the post's format again.
    await recordReview(deps(), id, {
      kind: "decline",
      instruction: "subject_format",
      declined: false,
    });
    expect(asEmailKit((await shown()).kit!).subject).toBe(asEmailKit(drafted.kit!).subject);
    await recordReview(deps(), id, {
      kind: "decline",
      instruction: "subject_format",
      declined: true,
    });
    // Sent with the subject jobkit wrote in place of the post's: changed, but no factual edit, as
    // the default subject says nothing about the owner the post's format did not (ledger spec).
    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });
    const { rows } = await db.query(
      "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ changed: ["subject"], factual_edit: false }]);
  });

  it("refuses to decline an instruction drafting did not apply", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");

    expect(
      await recordReview(deps(), id, { kind: "decline", instruction: "keyword", declined: true }),
    ).toEqual({ ok: false, reason: "not-in-kit" });
  });

  it("records at Mark sent what the owner changed in the words they last handed off, not as the email stands then", async () => {
    const outcome = async (steps: (id: string) => Promise<void>) => {
      await resetKitBed({ db, clock, storage });
      const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
        verdicts: [{ blockId: "S1", verdict: "supported", companyClaim: false, note: "" }],
      });
      await steps(id);
      expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
        ok: true,
      });
      const { rows } = await db.query(
        "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
        [id],
      );
      return rows[0];
    };
    const handedOff = async (id: string) => {
      const shown = (await jobView({ db, clock }, id))!;
      expect(
        await recordHandoff({ db, clock }, id, { kit: shown.kitKey!, words: shown.wordsKey! }),
      ).toEqual({ ok: true });
    };
    const words = "I have built production React applications for four years.";

    // Edited and handed off, then the edit taken back: the edited words went.
    expect(
      await outcome(async (id) => {
        await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: words });
        await recordReview(deps(), id, { kind: "confirm", blockId: "S1" });
        await handedOff(id);
        await recordReview(deps(), id, { kind: "revert", blockId: "S1" });
      }),
    ).toEqual({ changed: ["sentence:S1"], factual_edit: true });
    // Handed off as drafted, then edited: drafting's words went.
    expect(
      await outcome(async (id) => {
        await handedOff(id);
        await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: words });
        await recordReview(deps(), id, { kind: "confirm", blockId: "S1" });
      }),
    ).toEqual({ changed: [], factual_edit: false });
  });

  it("records each part as last handed off: a copy of the subject never stands for the body", async () => {
    const outcome = async (steps: (id: string) => Promise<void>, text = POSTED) => {
      await resetKitBed({ db, clock, storage });
      const id = await readyKit(text, {
        verdicts: [{ blockId: "S1", verdict: "supported", companyClaim: false, note: "" }],
      });
      await steps(id);
      expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
        ok: true,
      });
      const { rows } = await db.query(
        "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
        [id],
      );
      return rows[0];
    };
    const handedOff = async (id: string, parts?: ("subject" | "body")[]) => {
      const shown = (await jobView({ db, clock }, id))!;
      expect(
        await recordHandoff({ db, clock }, id, {
          kit: shown.kitKey!,
          words: shown.wordsKey!,
          ...(parts ? { parts } : {}),
        }),
      ).toEqual({ ok: true });
    };
    const words = "I have built production React applications for four years.";

    // The edited body copied, the edit taken back, then the subject copied: the edited body went.
    expect(
      await outcome(async (id) => {
        await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: words });
        await recordReview(deps(), id, { kind: "confirm", blockId: "S1" });
        await handedOff(id, ["body"]);
        await recordReview(deps(), id, { kind: "revert", blockId: "S1" });
        await handedOff(id, ["subject"]);
      }),
    ).toEqual({ changed: ["sentence:S1"], factual_edit: true });
    // The post's subject copied, its format then declined, then the body copied: the post's
    // subject went. A declined format's default subject is no factual edit either way.
    expect(
      await outcome(async (id) => {
        await handedOff(id, ["subject"]);
        await recordReview(deps(), id, {
          kind: "decline",
          instruction: "subject_format",
          declined: true,
        });
        await handedOff(id, ["body"]);
      }),
    ).toEqual({ changed: [], factual_edit: false });
    expect(
      await outcome(async (id) => {
        await recordReview(deps(), id, {
          kind: "decline",
          instruction: "subject_format",
          declined: true,
        });
        await handedOff(id);
      }),
    ).toEqual({ changed: ["subject"], factual_edit: false });
  });

  it("records the address the owner typed after Open in Gmail, their last word on where it goes", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.", {
      verdicts: [{ blockId: "S1", verdict: "supported", companyClaim: false, note: "" }],
    });
    // A typo handed off to Gmail, seen, and typed again; the second Open in Gmail never lands.
    await recordReview(deps(), id, { kind: "retype", value: "jobs@exmaple.com" });
    const shown = (await jobView({ db, clock }, id))!;
    await recordHandoff({ db, clock }, id, {
      kit: shown.kitKey!,
      words: shown.wordsKey!,
      to: "jobs@exmaple.com",
      parts: ["address", "subject", "body"],
    });
    await recordReview(deps(), id, { kind: "retype", value: "jobs@example.com" });
    expect((await jobView({ db, clock }, id))!.review!.decisions.handoff).toMatchObject({
      to: "",
      typed: false,
    });

    expect(
      await markSent({ db, clock }, id, null, { changedInGmail: true }, { to: "jobs@example.com" }),
    ).toMatchObject({ ok: true });

    const { rows } = await db.query<{ address: string }>(
      "select address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows[0]?.address).toBe("jobs@example.com");
  });

  it("counts an edit of a sentence the separate check called a claim about the company as factual", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      draft: withSecond({
        id: "S2",
        text: "Northwind Analytics is the leading analytics firm in Lahore.",
        paragraph_break: false,
        class: "post",
        fact_ids: [],
        fields: [],
        gap: NO_GAP,
      }),
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        {
          blockId: "S2",
          verdict: "not_a_claim",
          companyClaim: true,
          note: "A claim about the company.",
        },
      ],
    });
    await recordReview(deps(), id, {
      kind: "edit",
      blockId: "S2",
      text: "Northwind Analytics is the largest analytics firm in Asia, with 40,000 staff.",
    });
    await recordReview(deps(), id, { kind: "confirm", blockId: "S2" });

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });
    const { rows } = await db.query(
      "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ changed: ["sentence:S2"], factual_edit: true });
  });

  it("counts an edit of a sentence the separate check called a claim as factual, whatever the drafter called it", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      draft: {
        ...KIT_DRAFT,
        blocks: [
          ...KIT_DRAFT.blocks,
          {
            id: "S2",
            text: "Thank you for considering my application.",
            paragraph_break: false,
            class: "courtesy",
            fact_ids: [],
            fields: [],
            gap: { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" },
          },
        ],
      },
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "S2", verdict: "supported", companyClaim: false, note: "" },
      ],
    });
    await recordReview(deps(), id, {
      kind: "edit",
      blockId: "S2",
      text: "Thank you for considering my application, and my ten years of Kubernetes.",
    });
    await recordReview(deps(), id, { kind: "confirm", blockId: "S2" });

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });

    const { rows } = await db.query(
      "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ changed: ["sentence:S2"], factual_edit: true });
  });

  it("refuses a handoff from a page that showed another address, a copy setting no address of its own", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.", {
      verdicts: [{ blockId: "S1", verdict: "supported", companyClaim: false, note: "" }],
    });
    await recordReview(deps(), id, { kind: "retype", value: "jobs@example.com" });
    const first = (await jobView({ db, clock }, id))!;
    const shown = { kit: first.kitKey!, words: first.wordsKey! };
    expect(
      await recordHandoff({ db, clock }, id, {
        ...shown,
        to: "jobs@example.com",
        parts: ["address", "subject", "body"],
      }),
    ).toEqual({ ok: true });
    await recordReview(deps(), id, { kind: "retype", value: "hr@example.org" });

    // A page still showing the first address is refused; the copy names the new one, and sets no
    // address of its own: the one typed after Open in Gmail stands.
    expect(
      await recordHandoff({ db, clock }, id, {
        ...shown,
        to: "jobs@example.com",
        parts: ["subject"],
      }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await recordHandoff({ db, clock }, id, {
        ...shown,
        to: "hr@example.org",
        parts: ["subject"],
      }),
    ).toEqual({ ok: true });
    expect(
      await markSent({ db, clock }, id, null, { changedInGmail: false }, { to: "hr@example.org" }),
    ).toMatchObject({ ok: true });
    const { rows } = await db.query<{ address: string }>(
      "select address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows[0]?.address).toBe("hr@example.org");
  });

  it("records the draft the body was, the subject alone handed off counting as the draft shown", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      templates: true,
    });
    const first = (await jobView({ db, clock }, id))!;
    await recordHandoff({ db, clock }, id, {
      kit: first.kitKey!,
      words: first.wordsKey!,
      parts: ["subject"],
    });
    await pickDraft({ db, clock }, id, "T-ai-features", { kit: first.kitKey! });

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });
    const { rows } = await db.query<{ draft: string }>(
      "select draft from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows[0]?.draft).toBe("T-ai-features");
  });

  it("reads no handoff kept as one whole email, before handoffs were kept part by part", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const shown = (await jobView({ db, clock }, id))!;
    const whole = {
      ...JSON.parse(storedDecisions(shown.kitKey!, NO_DECISIONS)),
      handoff: { words: "00000000", changed: ["address", "subject"], factual: true, at: "x" },
    };
    await db.query("update {{schema}}.kit_reviews set decisions = $2::jsonb where job_id = $1", [
      id,
      JSON.stringify(whole),
    ]);

    expect((await jobView({ db, clock }, id))!.review!.decisions.handoff).toBeNull();
  });

  it("refuses a handoff from a page that showed other words, or another kit", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const shown = (await jobView({ db, clock }, id))!;
    await recordReview(deps(), id, {
      kind: "edit",
      blockId: "S1",
      text: "I have built production React applications for nine years.",
    });

    expect(
      await recordHandoff({ db, clock }, id, { kit: shown.kitKey!, words: shown.wordsKey! }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await recordHandoff({ db, clock }, id, { kit: "another kit", words: shown.wordsKey! }),
    ).toEqual({ ok: false, reason: "changed" });
  });

  it("keeps at least one sentence in the email", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");

    expect(await recordReview(deps(), id, { kind: "delete", blockId: "S1" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
    await recordReview(deps(), id, { kind: "add", after: "S1", text: "I lead code reviews." });
    expect((await recordReview(deps(), id, { kind: "delete", blockId: "S1" })).ok).toBe(true);
    expect(await recordReview(deps(), id, { kind: "delete", blockId: "N1" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
  });

  it("forgets, at the next decision, a check kept on a flag the email did not have, so it never comes back checked", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const view = (await jobView({ db, clock }, id))!;
    // As kept before checks were forgotten with their flag: no_claims checked while the email had none.
    const stale = flagKey({
      kind: "no_claims",
      at: "body",
      message:
        "The email says nothing about you yet. Write at least one sentence from your profile.",
    });
    await db.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, $2, $3::jsonb, '[]'::jsonb, $4)
       on conflict (job_id, role_id) do update set decisions = excluded.decisions`,
      [
        id,
        view.role!.id,
        storedDecisions(view.kitKey!, { ...NO_DECISIONS, flagsChecked: [stale] }),
        clock.now(),
      ],
    );
    expect((await jobView({ db, clock }, id))!.review!.decisions.flagsChecked).toEqual([stale]);

    const said = await recordReview(deps(), id, { kind: "edit", blockId: "S1", text: "—" });

    expect(
      said.ok &&
        said.gate.some((reason) => reason.kind === "flag" && reason.flag.kind === "no_claims"),
    ).toBe(true);
  });

  it("records a sentence the owner rewrote into a line about a must-have as a factual edit", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.", {
      templates: true,
    });
    const courtesy = (await jobView({ db, clock }, id))!.kit!.blocks.findLast(
      (block) => block.class === "courtesy",
    )!;
    for (const action of [
      { kind: "edit", blockId: courtesy.id, text: "I have not run React at that scale yet." },
      { kind: "answers", blockId: courtesy.id, requirementId: "R1" },
      { kind: "confirm", blockId: courtesy.id },
    ] as const) {
      await recordReview(deps(), id, action);
    }

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });
    const { rows } = await db.query<{ factual_edit: boolean }>(
      "select factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows[0]!.factual_edit).toBe(true);
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

    // A page drawn before flags were named posts the flag's place: no flag has that name now.
    expect(await recordReview(deps(), id, { kind: "check_flag", flag: "F1" })).toEqual({
      ok: false,
      reason: "not-in-kit",
    });
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
