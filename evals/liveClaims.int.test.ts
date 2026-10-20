import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock } from "@/adapters/clock";
import { createLocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { createJob } from "@/core/platform/jobs";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import {
  claimsForLabelling,
  claimsOfJob,
  keepClaims,
  labelClaim,
  liveClaims,
  scoreLive,
} from "./liveClaims";

/*
 * Claims from live drafts (evals spec, "Metrics", the judge; AC3's claim
 * labelling): the pull keeps a kept job's claims with their facts and the
 * check's verdicts, the owner labels each once with that verdict never
 * shown, and the check as it ran live is scored against the labels.
 */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");
const CASE = "live-2026-10-20-0123abcd";

let db: PgliteDb;
let dir: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jobkit-claims-"));
  await db.exec(
    `delete from {{schema}}.job_stage_runs; delete from {{schema}}.job_leases;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A job whose draft makes two claims, one citing a fact the version holds, as drafted, and the check's verdicts. */
async function draftedJob(): Promise<{ jobId: string; factId: string }> {
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  const storage = createLocalStorage({ root: join(dir, "storage"), origin: "http://x" });
  const seeded = await seedProfile({ db, storage, clock: fakeClock() }, checked);
  if (seeded.status === "refused") throw new Error(seeded.message);
  const { rows } = await db.query<{ id: string }>(
    "select id from {{schema}}.profile_versions where active",
  );
  const fact = checked.profile.facts.find((each) => each.approved)!;
  const jobId = await createJob(db, {
    state: "manual_run",
    receivedAt: new Date(),
    clientElapsedMs: 0,
  });
  const lease = await db.query<{ id: string }>(
    `insert into {{schema}}.job_leases (id, job_id, claimed_at, expires_at)
     values (gen_random_uuid(), $1, now(), now()) returning id`,
    [jobId],
  );
  const block = (id: string, text: string, kind: string, factIds: string[], owner = false) => ({
    id,
    text,
    paragraphBreak: false,
    class: kind,
    factIds,
    fields: [],
    gap: null,
    ...(owner ? { owner: true } : {}),
  });
  const draft = {
    kit: {
      kind: "email",
      subject: "Application",
      greeting: "Dear Hiring Manager,",
      closing: "Best regards,",
      blocks: [
        block("S1", "I am applying for the role.", "post", []),
        block("S2", "I led a team of fifty engineers.", "claim", [fact.id]),
        block("S3", "I built the billing system.", "claim", ["F-not-in-this-version"]),
        block("S4", "I wrote this one myself.", "claim", [fact.id], true),
      ],
    },
    profileVersion: rows[0]!.id,
  };
  const judged = {
    checked: true,
    verdicts: [{ blockId: "S2", verdict: "overstated", companyClaim: false, note: "" }],
    markers: [],
  };
  for (const [stage, output] of [
    ["draft", draft],
    ["judge", judged],
  ] as const) {
    await db.query(
      `insert into {{schema}}.job_stage_runs
         (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash, started_at, ended_at)
       values ($1, $2, $3, 0, 1, 'in', 'ok', $4, $3, now(), now())`,
      [jobId, lease.rows[0]!.id, stage, JSON.stringify(output)],
    );
  }
  return { jobId, factId: fact.id };
}

describe("claims from live drafts", () => {
  it("keeps a draft's claims with their facts and verdicts, labels each once, blind, and scores the check as it ran", async () => {
    const { jobId, factId } = await draftedJob();
    const folder = join(dir, "archive", CASE);
    mkdirSync(folder, { recursive: true });

    // The owner's own sentence and a claim citing a fact the version lacks are left out.
    const claims = await claimsOfJob(db, jobId);
    expect(claims).toMatchObject([
      { blockId: "S2", facts: [{ id: factId }], liveVerdict: "overstated" },
    ]);
    keepClaims(folder, jobId, claims);

    const archive = join(dir, "archive");
    const shown = claimsForLabelling(archive);
    expect(shown).toMatchObject([{ id: `${CASE}/S2`, label: null }]);
    expect(JSON.stringify(shown)).not.toContain("overstated");

    const at = new Date("2026-10-20T10:00:00Z");
    expect(labelClaim(archive, CASE, "S2", "not_supported", at)).toEqual({ ok: true });
    expect(labelClaim(archive, CASE, "S2", "supported", at)).toEqual({
      ok: false,
      reason: "labelled",
    });
    expect(labelClaim(archive, "../elsewhere", "S2", "supported", at)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(scoreLive(liveClaims(archive))).toMatchObject({
      claims: 1,
      notSupported: { precision: { successes: 1, n: 1 }, recall: { successes: 1, n: 1 } },
      accuracy: { successes: 1, n: 1 },
    });
  });
});
