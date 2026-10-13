import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm } from "@/adapters/fakeLlm";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { EXTRACT } from "@/core/extraction/extract";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import { runExtraction } from "./run";
import { caseOf, syntheticPosts } from "./synthetic";

/*
 * The public synthetic posts through the runner, each answered with its
 * recorded output: evals AC7's regression clause, with no network. Each
 * screenshot is a blank image of the post's render size, so the tiles are
 * those the rendered post would be cut into; the model's answer is the record.
 */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");

let db: PgliteDb;
let root: string;
let storage: LocalStorage;
let llm: FakeLlm;

async function blank(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .png()
      .toBuffer(),
  );
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jobkit-synthetic-"));
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

describe("the synthetic posts with their recorded outputs", () => {
  it("score right on every field they give, and meet every expectation extract checks", async () => {
    const posts = syntheticPosts(join(SYNTHETIC, "posts.yaml"));
    llm = fakeLlm(
      posts.map((post) =>
        answer(JSON.parse(readFileSync(join(SYNTHETIC, "records", `${post.id}.json`), "utf8"))),
      ),
    );
    const cases = await Promise.all(
      posts.map(async (post) => caseOf(post, await blank(post.render.width, post.render.height))),
    );

    const run = await runExtraction(
      { db, storage, clock: fakeClock(), random: cryptoRandom, llmFor: () => llm },
      cases,
      { model: EXTRACT.model, budgetUsd: 5 },
    );

    const wrong = run.cases.flatMap((result) => [
      ...(result.outcome === "scored" ? [] : [`${result.id}: ${result.outcome}, ${result.note}`]),
      ...Object.entries(result.matches ?? {})
        .filter(([, right]) => !right)
        .map(
          ([field]) => `${result.id}: ${field} read as "${result.extracted?.[field as "role"]}"`,
        ),
      ...result.checks
        .filter((check) => check.met === false)
        .map((check) => `${result.id}: ${check.key}, ${check.note}`),
    ]);
    expect(wrong).toEqual([]);
    expect(run.cases).toHaveLength(posts.length);
    expect(run.checks).toMatchObject({
      instructions: { successes: 2, n: 2 },
      scam_signals: { successes: 1, n: 1 },
      contact_flag: { successes: 2, n: 2 },
      language: { successes: 1, n: 1 },
      tiles: { successes: 1, n: 1 },
    });
    expect(run.metrics.contact.pooled.n).toBe(
      posts.filter((post) => post.expect.contact !== undefined).length,
    );
  });
});
