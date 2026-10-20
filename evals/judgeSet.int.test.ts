import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import { answer, fakeLlm } from "@/adapters/fakeLlm";
import type { PgliteDb } from "@/adapters/pglite";
import type { Fact } from "@/core/profile/schema";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import {
  type Candidate,
  compareJudgeRuns,
  createJudgeSet,
  forLabelling,
  type JudgeLabel,
  labelJudgeItem,
  readJudgeSet,
  runJudgeSet,
} from "./judgeSet";

/*
 * The frozen judge set (evals AC3's judge-set clause; the judge's metric):
 * made once from candidates and the profile's approved facts, labelled once
 * each with nothing of the intent shown, and run through the judge's own
 * prompt, its "not supported" calls scored against the labels.
 */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");

let db: PgliteDb;
let dir: string;
let facts: Fact[];

const random = { bytes: (length: number) => new Uint8Array(length).fill(5) };

beforeAll(async () => {
  db = await createTestDb();
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  facts = checked.profile.facts.filter((fact) => fact.approved);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jobkit-judge-set-"));
  await db.exec("delete from {{schema}}.model_calls");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Forty sentences meant each way, each citing the first approved fact. */
function candidates(each = 40): Candidate[] {
  return (["supported", "not_supported"] as const).flatMap((intent) =>
    Array.from({ length: each }, (_, i) => ({
      sentence: `${intent === "supported" ? "I built" : "I led a team of fifty building"} project ${i + 1}.`,
      factIds: [facts[0]!.id],
      intent,
    })),
  );
}

const verdict = (value: "supported" | "overstated") =>
  answer({ verdicts: [{ block_id: "S1", verdict: value, company_claim: false, note: "" }] });

describe("the judge set", () => {
  it("is made once from enough candidates, freezing their facts, and labelled once each, blind", () => {
    const file = join(dir, "judge-set.json");
    const at = new Date("2026-10-20T10:00:00Z");
    expect(() => createJudgeSet(file, candidates(39), facts, at)).toThrow(/at least 40/);
    expect(() =>
      createJudgeSet(
        file,
        [{ ...candidates()[0]!, factIds: ["F-none"] }, ...candidates()],
        facts,
        at,
      ),
    ).toThrow(/no approved fact/);

    const set = createJudgeSet(file, candidates(), facts, at);
    expect(set.items).toHaveLength(80);
    expect(set.items[0]).toMatchObject({ id: "J01", facts: [facts[0]], label: null });
    expect(() => createJudgeSet(file, candidates(), facts, at)).toThrow(/never changes/);
    expect(existsSync(`${file}.bak`)).toBe(true);
    // The page never sees what a sentence was meant to be.
    expect(JSON.stringify(forLabelling(set))).not.toContain("intent");

    expect(labelJudgeItem(file, "J01", "supported", at)).toEqual({ ok: true });
    expect(labelJudgeItem(file, "J01", "not_supported", at)).toEqual({
      ok: false,
      reason: "labelled",
    });
    expect(readJudgeSet(file)!.items[0]).toMatchObject({ label: "supported" });
  });

  it("scores the judge's not-supported calls on the labelled sentences, and compares two models", async () => {
    const file = join(dir, "judge-set.json");
    const at = new Date("2026-10-20T10:00:00Z");
    createJudgeSet(file, candidates(), facts, at);
    const labels: [string, JudgeLabel][] = [
      ["J01", "supported"],
      ["J02", "supported"],
      ["J41", "not_supported"],
      ["J42", "not_supported"],
    ];
    for (const [id, label] of labels) labelJudgeItem(file, id, label, at);
    const set = readJudgeSet(file)!;
    const run = (steps: Parameters<typeof fakeLlm>[0]) => {
      const llm = fakeLlm(steps);
      return runJudgeSet({ db, clock: fakeClock(), random, llmFor: () => llm }, set, {
        model: "gemini-3.8-flash",
        budgetUsd: 5,
      });
    };

    // Only the labelled sentences run: one called overstated wrongly, the two inflated ones caught.
    const first = await run([
      verdict("supported"),
      verdict("overstated"),
      verdict("overstated"),
      verdict("overstated"),
    ]);
    expect(first.items.map((each) => [each.id, each.verdict, each.right])).toEqual([
      ["J01", "supported", true],
      ["J02", "overstated", false],
      ["J41", "overstated", true],
      ["J42", "overstated", true],
    ]);
    expect(first.notSupported).toMatchObject({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 0,
      precision: { successes: 2, n: 3 },
      recall: { successes: 2, n: 2 },
    });
    expect(first.accuracy).toMatchObject({ successes: 3, n: 4 });

    const second = await run([
      verdict("supported"),
      verdict("supported"),
      verdict("overstated"),
      verdict("supported"),
    ]);
    expect(compareJudgeRuns(first, second)).toMatchObject({
      onlyFirst: 1,
      onlySecond: 1,
      both: 2,
      verdict: "no difference shown",
    });
  });
});
