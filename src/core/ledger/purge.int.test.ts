import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { confirmUploads, type ImageMeta, startJob, uploadAgain } from "@/core/intake/jobs";
import { purgeIntake } from "@/core/intake/purge";
import { createJob, expireUploads } from "@/core/platform/jobs";
import { createTestDb } from "@/server/db/testDb";

import { purgeLedger } from "./purge";

/*
 * The daily retention purges (intake AC7 and AC9, ledger AC9), with a fake
 * clock: screenshots and crops past 30 days unless kept, stray objects, a
 * screenshot that lands after its upload failed, old pasted text with its
 * links; records, drafts and recruiter names 180 days after an
 * application's last change, 30 days after a kit-less job's, the
 * application row kept.
 */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;

const DAY = 24 * 60 * 60 * 1000;
const PNG = new Uint8Array([1, 2, 3]);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-purge-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  await db.exec(
    `delete from {{schema}}.kit_reviews; delete from {{schema}}.status_changes;
     delete from {{schema}}.applications; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A job with one screenshot stored, its row, a crop, and pasted text. */
async function jobWithImage(kept: boolean): Promise<string> {
  const id = await createJob(db, {
    state: "manual_run",
    receivedAt: clock.now(),
    clientElapsedMs: 0,
  });
  await db.query(
    "update {{schema}}.jobs set pasted_text = 'A post.', post_links = '{https://example.com}' where id = $1",
    [id],
  );
  const path = `jobs/${id}/one.png`;
  await storage.put(path, PNG, "image/png");
  await storage.put(`jobs/${id}/crops/contact.png`, PNG, "image/png");
  await db.query(
    `insert into {{schema}}.job_images
       (job_id, position, purpose, storage_path, content_type, width, height, bytes, sha256,
        tile_count, created_at, purge_after, kept_for_eval)
     values ($1, 0, 'post', $2, 'image/png', 10, 10, 3, 'abc', 1, $3, $4, $5)`,
    [id, path, clock.now(), new Date(clock.now().getTime() + 30 * DAY), kept],
  );
  return id;
}

/** What the phone declares for a screenshot of `PNG`'s bytes, its hash told apart by `n`. */
const shot = (n: number): ImageMeta => ({
  contentType: "image/png",
  bytes: PNG.length,
  width: 10,
  height: 10,
  sha256: n.toString(16).padStart(64, "0"),
});

/** The phone's upload of `PNG` through a signed upload URL, as the storage takes it. */
const upload = (url: string) =>
  storage.acceptSignedUpload(new URL(url).pathname.split("/").pop()!, PNG);

const NOTHING = { images: 0, crops: 0, strays: 0, pastedTexts: 0 };

describe("the daily purges", () => {
  it("deletes screenshots, crops and pasted text with its links past 30 days unless kept, and stray objects", async () => {
    const gone = await jobWithImage(false);
    const kept = await jobWithImage(true);
    // An object no row names, as an add never confirmed leaves.
    await storage.put(`jobs/${kept}/stray.png`, PNG, "image/png");
    // Each was drawn into an arm, keeping its post's hashes.
    await db.query("update {{schema}}.jobs set arm = 'tool', post_hashes = $1", [["a".repeat(64)]]);

    clock.advance(29 * DAY);
    expect(await purgeIntake({ db, clock, storage })).toEqual({
      images: 0,
      crops: 0,
      strays: 1,
      pastedTexts: 0,
    });

    clock.advance(2 * DAY);
    expect(await purgeIntake({ db, clock, storage })).toEqual({
      images: 1,
      crops: 1,
      strays: 0,
      pastedTexts: 1,
    });
    expect(await storage.list(`jobs/${gone}`)).toEqual([]);
    expect((await storage.list(`jobs/${kept}`)).sort()).toEqual([
      `jobs/${kept}/crops/contact.png`,
      `jobs/${kept}/one.png`,
    ]);
    const { rows } = await db.query<{
      id: string;
      pasted_text: string | null;
      post_links: string[];
      post_hashes: string[];
    }>("select id, pasted_text, post_links, post_hashes from {{schema}}.jobs");
    // The links found in the post, and its hashes, go with its text.
    expect(
      Object.fromEntries(
        rows.map((row) => [row.id, [row.pasted_text, row.post_links, row.post_hashes]]),
      ),
    ).toEqual({
      [gone]: [null, [], []],
      [kept]: ["A post.", ["https://example.com"], ["a".repeat(64)]],
    });
    // Run twice, as the daily job may be: nothing more goes.
    expect(await purgeIntake({ db, clock, storage })).toEqual({
      images: 0,
      crops: 0,
      strays: 0,
      pastedTexts: 0,
    });
  });

  it("keeps a screenshot that lands after its upload timed out, since its row still names it, until the row's 30 days are up (intake AC7)", async () => {
    const began = clock.now().getTime();
    const started = await startJob(
      { db, clock, storage },
      { images: [shot(1)], pastedText: "", clientElapsedMs: 0 },
    );
    if (!started.ok) throw new Error(started.message);
    clock.advance(15 * 60_000 + 1);
    expect(await expireUploads(db, clock.now())).toBe(1);
    // A signed upload URL lives two hours, so the phone's upload can still land after the
    // timeout, at the path the screenshot's row names.
    expect(await upload(started.uploads[0]!.url)).toBe(true);
    const folder = `jobs/${started.jobId}`;
    const late = await storage.list(folder);
    expect(late).toHaveLength(1);

    // The next day's purge keeps it: it is no stray, but the job's screenshot.
    clock.advance(DAY);
    expect(await purgeIntake({ db, clock, storage })).toEqual(NOTHING);
    expect(await storage.list(folder)).toEqual(late);

    // It goes with its row, 30 days after the job began uploading, not after it landed.
    clock.advance(began + 30 * DAY - clock.now().getTime());
    expect(await purgeIntake({ db, clock, storage })).toEqual({ ...NOTHING, images: 1 });
    expect(await storage.list(folder)).toEqual([]);
  });

  it("deletes a screenshot that lands after Upload again replaced it, as a stray, once the job has left uploading (intake AC7)", async () => {
    const deps = { db, clock, storage };
    const started = await startJob(deps, { images: [shot(1)], pastedText: "", clientElapsedMs: 0 });
    if (!started.ok) throw new Error(started.message);
    clock.advance(15 * 60_000 + 1);
    expect(await expireUploads(db, clock.now())).toBe(1);
    const again = await uploadAgain(deps, started.jobId, [shot(2)]);
    if (!again.ok) throw new Error(JSON.stringify(again));
    // The first upload's URL still works: its screenshot lands at a path no row names now.
    expect(await upload(started.uploads[0]!.url)).toBe(true);
    const folder = `jobs/${started.jobId}`;
    const late = await storage.list(folder);
    expect(late).toHaveLength(1);

    // While the job uploads again, the purge leaves its folder alone.
    expect(await purgeIntake(deps)).toEqual(NOTHING);
    expect(await storage.list(folder)).toEqual(late);

    // The screenshot chosen again arrives and is confirmed: the job has left uploading.
    expect(await upload(again.uploads[0]!.url)).toBe(true);
    expect(await confirmUploads(deps, started.jobId)).toEqual({ ok: true });
    expect(await purgeIntake(deps)).toEqual({ ...NOTHING, strays: 1 });
    const { rows } = await db.query<{ storage_path: string }>(
      "select storage_path from {{schema}}.job_images where job_id = $1",
      [started.jobId],
    );
    expect(await storage.list(folder)).toEqual(rows.map((row) => row.storage_path));
  });

  it("clears a job's record and drafts 180 days after its application last changed, keeping the application", async () => {
    const withApplication = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    const kitless = await createJob(db, {
      state: "manual_run",
      receivedAt: clock.now(),
      clientElapsedMs: 0,
    });
    await db.query(
      "update {{schema}}.jobs set state = 'stopped', state_changed_at = $2 where id = $1",
      [kitless, clock.now()],
    );
    const lease = await db.query<{ id: string }>(
      `insert into {{schema}}.job_leases (id, job_id, claimed_at, expires_at)
       values (gen_random_uuid(), $1, $2, $2), (gen_random_uuid(), $3, $2, $2)
       returning id`,
      [withApplication, clock.now(), kitless],
    );
    for (const [i, job] of [withApplication, kitless].entries()) {
      await db.query(
        `insert into {{schema}}.job_stage_runs
           (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash, started_at, ended_at)
         values ($1, $2, 'extract', 0, 1, 'in', 'ok', '{"record": {"recruiter": {"name": "Ana"}}}', 'out', $3, $3)`,
        [job, lease.rows[i]!.id, clock.now()],
      );
    }
    await db.query(
      `insert into {{schema}}.applications
         (job_id, role_id, company, role, role_key, route, status, opened_at, status_changed_at,
          final_draft, post_fingerprint, job_kind)
       values ($1, 'P1', 'Northwind', 'Developer', 'developer', 'email', 'sent', $2, $2,
               '{"body": "Dear Ana"}', '{abc}', 'real')`,
      [withApplication, clock.now()],
    );
    await db.query(
      `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
       values ($1, 'P1', '{"typed": "ana@example.com"}', '[]', $2)`,
      [withApplication, clock.now()],
    );

    clock.advance(31 * DAY);
    expect(await purgeLedger({ db, clock })).toEqual({ jobs: 1 });
    clock.advance(150 * DAY);
    expect(await purgeLedger({ db, clock })).toEqual({ jobs: 1 });
    expect(await purgeLedger({ db, clock })).toEqual({ jobs: 0 });

    const runs = await db.query<{ output: unknown; started_at: Date }>(
      "select output, started_at from {{schema}}.job_stage_runs",
    );
    expect(runs.rows.map((run) => run.output)).toEqual([null, null]);
    const application = await db.query(
      "select company, role, status, final_draft, post_fingerprint from {{schema}}.applications",
    );
    expect(application.rows).toEqual([
      {
        company: "Northwind",
        role: "Developer",
        status: "sent",
        final_draft: null,
        post_fingerprint: ["abc"],
      },
    ]);
    expect((await db.query("select 1 from {{schema}}.kit_reviews")).rows).toEqual([]);
  });

  it("keeps the records of a job kept for evaluation, and clears a role never picked after 30 days", async () => {
    const kept = await jobWithImage(true);
    const unpicked = await jobWithImage(false);
    for (const [job, state] of [
      [kept, "stopped"],
      [unpicked, "needs_role_pick"],
    ]) {
      await db.query("update {{schema}}.jobs set state = $2, state_changed_at = $3 where id = $1", [
        job,
        state,
        clock.now(),
      ]);
      const lease = await db.query<{ id: string }>(
        `insert into {{schema}}.job_leases (id, job_id, claimed_at, expires_at)
         values (gen_random_uuid(), $1, $2, $2) returning id`,
        [job, clock.now()],
      );
      await db.query(
        `insert into {{schema}}.job_stage_runs
           (job_id, lease_id, stage, round, attempt, input_hash, outcome, output, output_hash, started_at, ended_at)
         values ($1, $2, 'extract', 0, 1, 'in', 'ok', '{"record": {}}', 'out', $3, $3)`,
        [job, lease.rows[0]!.id, clock.now()],
      );
    }

    clock.advance(31 * DAY);
    expect(await purgeLedger({ db, clock })).toEqual({ jobs: 1 });
    const { rows } = await db.query<{ job_id: string; output: unknown }>(
      "select job_id, output from {{schema}}.job_stage_runs",
    );
    expect(Object.fromEntries(rows.map((row) => [row.job_id, row.output !== null]))).toEqual({
      [kept]: true,
      [unpicked]: false,
    });
  });
});
