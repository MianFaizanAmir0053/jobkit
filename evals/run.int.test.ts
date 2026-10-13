import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm, usageOf } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { EXTRACT } from "@/core/extraction/extract";
import type { JobRecord } from "@/core/extraction/record";
import { provisionalCost } from "@/core/platform/prices";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import type { Labels } from "./cases";
import { type EvalCase, estimateCase, type RunDeps, runExtraction } from "./run";

/* The runner's extraction runs: evals AC5's budget clause, on the app's own stages with fake models. */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");
const fixture = (id: string): JobRecord =>
  JSON.parse(readFileSync(join(SYNTHETIC, "records", `${id}.json`), "utf8")) as JobRecord;

let db: PgliteDb;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;

const deps = (): RunDeps => ({
  db,
  storage,
  clock: fakeClock(),
  random: cryptoRandom,
  llmFor: () => llm,
});

async function png(height: number, shade: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 1080, height, channels: 3, background: { r: shade, g: shade, b: shade } },
    })
      .png()
      .toBuffer(),
  );
}

async function evalCase(id: string, labels: Partial<Labels>, shade = 10): Promise<EvalCase> {
  return {
    id,
    split: "dev",
    images: [{ bytes: await png(2400, shade), contentType: "image/png" }],
    pastedText: "",
    labels: {
      company: "",
      role: "",
      route: "email",
      contact: "",
      eligibility: "eligible",
      must: [],
      cropShowsContact: null,
      ...labels,
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
  root = mkdtempSync(join(tmpdir(), "jobkit-run-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  await seedProfile({ db, storage, clock: fakeClock() }, checked);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runExtraction", () => {
  it("runs extract and eligibility through the app's runner, takes the labelled role, and scores each field", async () => {
    const simple = fixture("S01-email-simple");
    const two = fixture("S07-two-roles");
    llm = fakeLlm([answer(simple), answer(two)]);
    const cases = [
      await evalCase("live-2026-10-06-00000001", {
        company: simple.company.name,
        role: "Senior Full-Stack Engineer",
        contact: "jobs@example.com",
      }),
      await evalCase("live-2026-10-06-00000002", {
        company: `${two.company.name} Ltd.`,
        role: "Machine Learning Engineer",
        contact: "ML@example.com",
      }),
    ];

    const run = await runExtraction(deps(), cases, { model: EXTRACT.model, budgetUsd: 5 });

    expect(run.cases.map((result) => [result.outcome, result.extracted?.role])).toEqual([
      ["scored", "Senior Full-Stack Engineer"],
      ["scored", "Machine Learning Engineer"],
    ]);
    for (const result of run.cases) {
      expect(result.matches).toEqual({
        company: true,
        role: true,
        route: true,
        contact: true,
        eligibility: result.extracted!.eligibility === "eligible",
      });
      expect(result.extracted!.eligibility).not.toBe("");
      expect(result.costUsd).toBeGreaterThan(0);
    }
    expect(run.metrics.role.pooled).toMatchObject({ successes: 2, n: 2 });
    expect(run.metrics.contact.byRoute.email).toMatchObject({ successes: 2, n: 2 });
    expect(run.stoppedAtBudget).toBe(false);
  });

  it("counts a post read as having no role as wrong on every field of one", async () => {
    llm = fakeLlm([answer(fixture("S08-urdu"))]);
    const urdu = await evalCase("live-2026-10-06-00000003", {
      role: "Web Developer",
      route: "linkedin_comment",
      contact: "",
    });

    const [result] = (await runExtraction(deps(), [urdu], { model: EXTRACT.model, budgetUsd: 5 }))
      .cases;

    expect(result).toMatchObject({ outcome: "scored", note: "The post stopped: language." });
    expect(result!.matches).toMatchObject({
      role: false,
      route: false,
      contact: false,
      eligibility: false,
    });
  });

  it("stops before any call that could pass its budget, and scores no case the budget cut short", async () => {
    // The fake model counts 1,000 input tokens, and answers at the output limit: each call costs its most.
    const perCall = provisionalCost(EXTRACT.model, 1_000, EXTRACT.maxTokens, new Date()).usd;
    const costly = answer(fixture("S01-email-simple"), {
      usage: [usageOf(EXTRACT.model, 1_000, EXTRACT.maxTokens)],
    });
    llm = fakeLlm([costly, costly, costly]);
    const cases = [
      await evalCase("live-2026-10-06-00000004", {}, 10),
      await evalCase("live-2026-10-06-00000005", {}, 20),
      await evalCase("live-2026-10-06-00000006", {}, 30),
    ];

    const run = await runExtraction(deps(), cases, {
      model: EXTRACT.model,
      budgetUsd: perCall * 1.5,
    });

    expect(run.cases.map((result) => result.outcome)).toEqual(["scored", "budget", "budget"]);
    expect(llm.calls).toHaveLength(1);
    expect(run.stoppedAtBudget).toBe(true);
    expect(run.costUsd).toBeLessThanOrEqual(perCall * 1.5);
    expect(run.metrics.company.pooled.n).toBe(1);
  });
});

describe("estimateCase", () => {
  it("gives the most a case's extraction can cost, by its screenshots' tiles", async () => {
    const at = new Date();
    const one = await estimateCase(
      await evalCase("live-2026-10-06-00000007", {}),
      EXTRACT.model,
      at,
    );
    const tall: EvalCase = {
      ...(await evalCase("live-2026-10-06-00000008", {})),
      images: [{ bytes: await png(6000, 10), contentType: "image/png" }],
    };

    expect(one).toBeGreaterThan(provisionalCost(EXTRACT.model, 0, EXTRACT.maxTokens, at).usd);
    expect(await estimateCase(tall, EXTRACT.model, at)).toBeGreaterThan(one);
  });
});
