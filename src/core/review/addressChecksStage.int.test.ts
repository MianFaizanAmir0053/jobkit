import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import type { ExtractOutput } from "@/core/extraction/extract";
import { loadJob } from "@/core/platform/jobs";
import { type StageContext, stageOutput } from "@/core/platform/runner";
import { createTestDb } from "@/server/db/testDb";

import { ADDRESS_CHECKS_VERSION } from "./addressChecks";
import { addressChecksStage } from "./addressChecksStage";
import { readyKit, resetKitBed } from "./testKit";

/*
 * What the `address_checks` stage's input hash covers (platform spec B9,
 * "Stage runs and idempotency"; AC17): the address and the company name the
 * checks read, and the checks' version, so a kept lookup is reused only for
 * the same address.
 */

const POST = "Northwind Analytics is hiring. Apply by email to jobs@example.com.";

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

async function contextOf(id: string): Promise<StageContext> {
  return { job: (await loadJob(db, id))!, outputOf: (stage) => stageOutput(db, id, stage) };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-address-checks-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("address_checks' input", () => {
  it("covers the address the post gives, the company the name check reads, and the checks' version", async () => {
    const id = await readyKit({ db, clock, storage }, POST);
    const ctx = await contextOf(id);
    const inputNow = async () =>
      (await addressChecksStage({ db, dns: offlineDns() }).input(ctx)) as Record<string, unknown>;

    expect(await inputNow()).toEqual({
      address: "jobs@example.com",
      company: "Northwind Analytics",
      version: ADDRESS_CHECKS_VERSION,
    });

    // The post read again, giving another address and company: the checks follow that reading.
    const read = (await stageOutput(db, id, "extract"))!.output as ExtractOutput;
    const again = structuredClone(read);
    again.record.company.name = "Contoso Health";
    const route = again.record.roles[0]!.route;
    if (route.kind !== "email") throw new Error("S01 applies by email");
    route.address = "careers@contoso.example ";
    await db.query(
      `insert into {{schema}}.job_stage_runs
         (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash,
          started_at, ended_at)
       select job_id, lease_id, 'extract', round, 2, 'read again', 'ok', $2, 'read again',
              started_at, ended_at
         from {{schema}}.job_stage_runs where job_id = $1 and stage = 'extract'`,
      [id, JSON.stringify(again)],
    );
    expect(await inputNow()).toEqual({
      address: "careers@contoso.example",
      company: "Contoso Health",
      version: ADDRESS_CHECKS_VERSION,
    });
  });
});
