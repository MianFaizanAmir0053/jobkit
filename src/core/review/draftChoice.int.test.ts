import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, refusal } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { BlockVerdict } from "@/core/drafting/verdict";
import type { JobRecord } from "@/core/extraction/record";
import { moveJob } from "@/core/platform/jobs";
import { stageOutput } from "@/core/platform/runner";
import type { Dns } from "@/core/ports";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";
import { createTestDb } from "@/server/db/testDb";

import { backToDrafts, draftWithGemini, pickDraft } from "./draftChoice";
import { type JobView, jobView } from "./jobView";
import { recordReview } from "./kitReview";
import { markSent } from "./markSent";
import { scheduleSend } from "./send";
import { KIT_DRAFT, type KitOptions, readyKit as kitFor, resetKitBed, runKit } from "./testKit";

/* Drafts from the owner's templates, beside Gemini's on request, ranked, one picked: decisions A21 and A22. */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

const POST = "Northwind Analytics is hiring. Apply to jobs@example.com.";
/** A post with no address in it: the owner types one, a decision on the post. */
const NO_ADDRESS = "Northwind Analytics is hiring. Apply on our site.";

const bed = () => ({ db, clock, storage });
const readyKit = (text: string, opts?: KitOptions) => kitFor(bed(), text, opts);
const view = async (id: string): Promise<JobView> => (await jobView({ db, clock }, id))!;
const kinds = (shown: JobView) => shown.review!.gate.map((reason) => reason.kind);
const steps = (shown: JobView) => shown.steps.map((step) => [step.stage, step.status]);
const ask = async (id: string) =>
  draftWithGemini({ db, clock }, id, { kit: (await view(id)).kitKey! });

/** The separate check finds Gemini's one sentence supported. */
const SUPPORTED: BlockVerdict[] = [
  { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
];

/** A DNS where example.com takes mail. */
const mail: Dns = {
  async lookup(name, type) {
    return type === "MX" && name === "example.com"
      ? { kind: "records", values: ["mx.example.com"] }
      : { kind: "none" };
  },
};

/** The post asks for a degree, which code cannot weigh: each template draft asks the owner to confirm it. */
const askingForADegree = (record: JobRecord): JobRecord => ({
  ...record,
  roles: record.roles.map((role) => ({
    ...role,
    requirements: [
      ...role.requirements,
      {
        id: "R5",
        text: "BSc in Computer Science",
        priority: "must",
        kind: "education",
        skills: [],
        depth: "any",
        years: -1,
      },
    ],
  })),
});

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-drafts-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed(bed());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a kit the templates draft", () => {
  it("is ready at once, with no Gemini call, its drafts best first and the first shown", async () => {
    const id = await readyKit(POST, { templates: true });

    const shown = await view(id);
    expect(shown.state).toBe("kit_ready");
    expect(shown.drafts.map((draft) => [draft.id, draft.source, draft.coverage])).toEqual([
      ["T-full-stack", "template", 1],
      ["T-ai-features", "template", 1],
    ]);
    expect(shown.picked).toBe("T-full-stack");
    expect(shown.draft!.kit.blocks.map((block) => block.text)[1]).toBe(
      "I have shipped React and Next.js applications in production for five years.",
    );
    expect(steps(shown)).toEqual([
      ["extract", "done"],
      ["eligibility", "done"],
      ["templates", "done"],
      ["draft", "skipped"],
      ["judge", "skipped"],
    ]);
    // Its sentences are the owner's approved words: nothing for a separate check to hold.
    expect(shown.review!.gate).toEqual([]);
    expect(shown.judge).toBeNull();
    expect(shown.canDraftWithGemini).toBe(true);
    const { rows } = await db.query<{ stage: string }>("select stage from {{schema}}.model_calls");
    expect(rows.map((row) => row.stage)).toEqual(["extract"]);
  });

  it("is drafted by Gemini as before when no template fits, and Gemini's draft is then the only one", async () => {
    const id = await readyKit(POST);

    const shown = await view(id);
    expect(shown.drafts.map((draft) => [draft.id, draft.source, draft.open])).toEqual([
      ["gemini", "gemini", 1],
    ]);
    expect(shown.picked).toBe("gemini");
    expect(steps(shown)).toEqual([
      ["extract", "done"],
      ["eligibility", "done"],
      ["templates", "none_fit"],
      ["draft", "done"],
      ["judge", "done"],
    ]);
    expect(kinds(shown)).toEqual(["judge"]);
    expect(shown.canDraftWithGemini).toBe(false);
  });
});

describe("pickDraft", () => {
  it("makes the draft picked the kit: each keeps its own sentence and flag decisions, the post's go with the pick", async () => {
    const id = await readyKit(NO_ADDRESS, { templates: true, record: askingForADegree });
    const first = await view(id);
    expect(first.drafts.map((draft) => [draft.id, draft.open])).toEqual([
      ["T-full-stack", 1],
      ["T-ai-features", 1],
    ]);
    expect(kinds(first)).toEqual(["contact", "flag"]);
    const decide = { db, clock, dns: mail };
    await recordReview(decide, id, { kind: "retype", value: "jobs@example.com" });
    await recordReview(decide, id, { kind: "check_flag", flag: "F1" });
    expect(kinds(await view(id))).toEqual([]);

    const picked = await pickDraft({ db, clock }, id, "T-ai-features", { kit: first.kitKey! });

    expect(picked).toEqual({ ok: true, gate: [expect.objectContaining({ kind: "flag" })] });
    const other = await view(id);
    expect(other.picked).toBe("T-ai-features");
    expect(other.kitKey).not.toBe(first.kitKey);
    expect(other.review!.decisions).toMatchObject({
      retyped: { value: "jobs@example.com" },
      flagsChecked: [],
    });
    expect(other.handoff).toEqual({ to: "jobs@example.com", typed: true });

    // Back to the first: its flag stays checked, and the typed address too.
    await pickDraft({ db, clock }, id, "T-full-stack", { kit: other.kitKey! });
    const again = await view(id);
    expect(again.kitKey).toBe(first.kitKey);
    expect(again.review!.decisions.flagsChecked).toEqual(["F1"]);
    expect(kinds(again)).toEqual([]);
  });

  it("keeps the draft shown when picked, and refuses a pick from another kit's page, of a draft the kit lacks, or while it sends", async () => {
    const id = await readyKit(POST, { templates: true });
    const shown = await view(id);

    expect(await pickDraft({ db, clock }, id, "T-full-stack", { kit: shown.kitKey! })).toEqual({
      ok: true,
      gate: [],
    });
    const { rows } = await db.query<{ picked_draft: string }>(
      "select picked_draft from {{schema}}.kit_reviews where job_id = $1",
      [id],
    );
    expect(rows[0]!.picked_draft).toBe("T-full-stack");
    expect(await pickDraft({ db, clock }, id, "T-ai-features", { kit: "another kit" })).toEqual({
      ok: false,
      reason: "changed",
    });
    for (const draft of ["T-not-in-the-profile", "gemini"]) {
      expect(await pickDraft({ db, clock }, id, draft, { kit: shown.kitKey! })).toEqual({
        ok: false,
        reason: "not-in-kit",
      });
    }
    // Approve & send counting down: nothing changes what it sends.
    const scheduled = await scheduleSend({ db, clock }, id, {
      kit: shown.kitKey!,
      to: shown.handoff!.to,
      uncertain: null,
      sessionId: null,
    });
    expect(scheduled.ok).toBe(true);
    expect(await pickDraft({ db, clock }, id, "T-ai-features", { kit: shown.kitKey! })).toEqual({
      ok: false,
      reason: "sending",
    });
    expect((await view(id)).picked).toBe("T-full-stack");
  });
});

describe("draftWithGemini", () => {
  it("ranks Gemini's draft among the templates', and keeps the draft shown and its decisions though Gemini's ranks first", async () => {
    const opts = { templates: true, verdicts: SUPPORTED };
    const id = await readyKit(NO_ADDRESS, opts);
    await recordReview({ db, clock, dns: mail }, id, { kind: "retype", value: "jobs@example.com" });
    const before = await view(id);
    expect(kinds(before)).toEqual([]);

    expect(await ask(id)).toEqual({ ok: true });
    const drafting = await view(id);
    expect(drafting.state).toBe("drafting");
    expect(drafting.steps.find((step) => step.stage === "judge")!.status).toBe("waiting");
    await runKit(bed(), id, [answer(KIT_DRAFT)], opts);

    const after = await view(id);
    expect(after.state).toBe("kit_ready");
    // Gemini's covers as much, has nothing to check and is shorter: it is recommended now.
    expect(after.drafts.map((draft) => [draft.id, draft.coverage, draft.open])).toEqual([
      ["gemini", 1, 0],
      ["T-full-stack", 1, 0],
      ["T-ai-features", 1, 0],
    ]);
    expect(after.picked).toBe("T-full-stack");
    expect(after.kitKey).toBe(before.kitKey);
    expect(after.review!.decisions.retyped?.value).toBe("jobs@example.com");
    expect(steps(after).slice(2)).toEqual([
      ["templates", "done"],
      ["draft", "done"],
      ["judge", "done"],
    ]);
    expect(after.canDraftWithGemini).toBe(false);
    expect(await ask(id)).toEqual({ ok: false, reason: "drafted" });

    expect(await pickDraft({ db, clock }, id, "gemini", { kit: after.kitKey! })).toMatchObject({
      ok: true,
      gate: [],
    });
    expect((await view(id)).draft!.kit.blocks.map((block) => block.text)).toEqual([
      "I have built production React applications for five years.",
    ]);
  });

  it("is refused on a kit Gemini drafted, and from a page drawn on another kit", async () => {
    const drafted = await readyKit(POST);
    expect(await ask(drafted)).toEqual({ ok: false, reason: "drafted" });

    const id = await readyKit("Another post. Apply to jobs@example.com.", { templates: true });
    expect(await draftWithGemini({ db, clock }, id, { kit: "another kit" })).toEqual({
      ok: false,
      reason: "changed",
    });
    expect((await view(id)).state).toBe("kit_ready");
  });

  it("starts a new round of attempts each time, so earlier failures never fail it at once", async () => {
    const id = await readyKit(POST, { templates: true });
    for (let refused = 0; refused < 3; refused++) {
      await ask(id);
      await runKit(bed(), id, [refusal()], { templates: true });
      expect((await view(id)).state).toBe("failed");
      expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: true });
    }

    await ask(id);
    await runKit(bed(), id, [answer(KIT_DRAFT)], { templates: true });

    expect((await view(id)).drafts.map((draft) => draft.id)).toContain("gemini");
    const { rows } = await db.query<{ count: number }>(
      "select count(*)::int as count from {{schema}}.model_calls where stage = 'draft'",
    );
    expect(rows[0]!.count).toBe(4);
  });
});

describe("backToDrafts", () => {
  it("makes the kit ready again with the templates' drafts when the Gemini draft fails", async () => {
    const id = await readyKit(POST, { templates: true });
    expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: false, reason: "not-failed" });
    await ask(id);
    await runKit(bed(), id, [refusal()], { templates: true });
    const failed = await view(id);
    expect(failed.state).toBe("failed");
    expect(failed.steps.find((step) => step.stage === "draft")!.status).toBe("failed");
    expect(failed.canGoBackToDrafts).toBe(true);

    expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: true });

    const back = await view(id);
    expect(back.state).toBe("kit_ready");
    expect(back.failure).toBeNull();
    expect(back.drafts.map((draft) => draft.id)).toEqual(["T-full-stack", "T-ai-features"]);
    expect(steps(back).slice(3)).toEqual([
      ["draft", "failed"],
      ["judge", "waiting"],
    ]);
    expect(back.review!.gate).toEqual([]);
    expect(back.canDraftWithGemini).toBe(true);
    expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: false, reason: "not-failed" });
  });

  it("offers no Gemini draft its check never weighed: back from a failed check, the templates' alone", async () => {
    const id = await readyKit(POST, { templates: true });
    await ask(id);
    await runKit(bed(), id, [answer(KIT_DRAFT)], { templates: true, verdicts: "fails" });
    expect((await view(id)).state).toBe("failed");

    expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: true });

    const back = await view(id);
    expect(back.drafts.map((draft) => draft.id)).toEqual(["T-full-stack", "T-ai-features"]);
    expect(steps(back).slice(3)).toEqual([
      ["draft", "done"],
      ["judge", "failed"],
    ]);
    // Asked again, the draft written is reused, and once checked it is offered.
    expect(await ask(id)).toEqual({ ok: true });
    await runKit(bed(), id, [], { templates: true, verdicts: SUPPORTED });
    expect((await view(id)).drafts.map((draft) => draft.id)).toContain("gemini");
  });

  it("has no way back for a job no template fitted", async () => {
    const id = await readyKit(POST);
    await db.query(
      "update {{schema}}.jobs set state = 'failed', pending_stage = 'draft', failed_stage = 'draft' where id = $1",
      [id],
    );

    expect((await view(id)).canGoBackToDrafts).toBe(false);
    expect(await backToDrafts({ db, clock }, id)).toEqual({ ok: false, reason: "not-failed" });
  });
});

describe("the kit's drafts over time", () => {
  it("counts a Gemini draft only from the current round of drafting", async () => {
    const id = await readyKit(POST);
    expect((await view(id)).drafts.map((draft) => draft.id)).toEqual(["gemini"]);

    // The post is read again, and this time the templates fit.
    await moveJob(db, id, {
      from: "kit_ready",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
    });
    await runKit(bed(), id, [], { templates: true });

    const again = await view(id);
    expect(again.state).toBe("kit_ready");
    expect(again.drafts.map((draft) => draft.id)).toEqual(["T-full-stack", "T-ai-features"]);
    expect(again.judge).toBeNull();
    expect(steps(again).slice(3)).toEqual([
      ["draft", "skipped"],
      ["judge", "skipped"],
    ]);
  });

  it("counts no draft of a round the post's new reading has started", async () => {
    const id = await readyKit(POST);
    expect((await view(id)).drafts.map((draft) => draft.id)).toEqual(["gemini"]);

    // The post is read again, and the round stops before the templates.
    await moveJob(db, id, {
      from: "kit_ready",
      to: "extracting",
      pending: "extract",
      at: clock.now(),
    });
    await runKit(bed(), id, [], { templates: true, eligibilityFails: true });

    const stopped = await view(id);
    expect(stopped.state).toBe("failed");
    expect(stopped.drafts).toEqual([]);
    expect(stopped.kitKey).toBeNull();
  });

  it("brings back a draft's own decisions when the page falls back to it", async () => {
    const id = await readyKit(POST, { templates: true, record: askingForADegree });
    const first = await view(id);
    await recordReview({ db, clock, dns: mail }, id, { kind: "check_flag", flag: "F1" });
    await pickDraft({ db, clock }, id, "T-ai-features", { kit: first.kitKey! });
    // The pick names a draft the kit no longer offers: the page shows the first again.
    await db.query("update {{schema}}.kit_reviews set picked_draft = 'gemini' where job_id = $1", [
      id,
    ]);

    const back = await view(id);
    expect(back.picked).toBe("T-full-stack");
    expect(back.review!.decisions.flagsChecked).toEqual(["F1"]);
  });

  it("keeps the key of a kit drafted before the templates, so decisions made on it still count", async () => {
    const id = await readyKit(POST);
    await db.query(
      "delete from {{schema}}.job_stage_runs where job_id = $1 and stage = 'templates'",
      [id],
    );
    const outputs: Record<string, string> = {};
    for (const stage of ["extract", "address_read", "address_checks", "draft", "judge"] as const) {
      const kept = await stageOutput(db, id, stage);
      if (kept) outputs[stage] = kept.outputHash;
    }

    const shown = await view(id);
    expect(shown.kitKey).toBe(sha256Hex(canonicalJson({ role: shown.role!.id, outputs })));
    // Its steps are the ones it ran.
    expect(shown.steps.map((step) => step.stage)).toEqual([
      "extract",
      "eligibility",
      "draft",
      "judge",
    ]);
  });

  it("records which draft went with the email's outcome", async () => {
    const id = await readyKit(POST, { templates: true });

    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toMatchObject({
      ok: true,
    });

    const { rows } = await db.query<{ draft: string }>(
      "select draft from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows.map((row) => row.draft)).toEqual(["T-full-stack"]);
  });
});
