import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { costOf } from "@/core/platform/prices";
import { createTestDb } from "@/server/db/testDb";

import { monthToDateCost, spendGuard, spendState } from "./spend";

let db: PgliteDb;
let clock: FakeClock;
const deps = () => ({ db, clock });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.model_calls");
  // Mid-October 2026, UTC.
  clock = fakeClock(new Date("2026-10-15T12:00:00Z"));
});

/** A logged model call, as the wrapper writes one. */
async function call(
  usd: number,
  startedAt = "2026-10-10T09:00:00Z",
  fields: { outcome?: string; provisional?: boolean; priceKnown?: boolean } = {},
): Promise<void> {
  await db.query(
    `insert into {{schema}}.model_calls
       (stage, attempt, provider, requested_model, started_at, outcome, cost_usd,
        cost_provisional, price_known)
     values ('extract', 1, 'anthropic', 'claude-opus-5-5', $1, $2, $3, $4, $5)`,
    [new Date(startedAt), fields.outcome ?? "ok", usd, fields.provisional ?? false, fields.priceKnown ?? true],
  );
}

describe("monthToDateCost", () => {
  it("sums this UTC calendar month's calls, provisional and unfinished ones included", async () => {
    await call(1.5);
    await call(0.36, "2026-10-14T09:00:00Z", { outcome: "started", provisional: true });
    await call(0.2, "2026-10-01T00:00:00Z");
    await call(9, "2026-09-30T23:59:59Z");

    expect(await monthToDateCost(db, clock.now())).toBe(2.06);
  });

  it("is zero in a month with no calls", async () => {
    await call(9, "2026-09-30T23:59:59Z");

    expect(await monthToDateCost(db, clock.now())).toBe(0);
  });
});

describe("spendState", () => {
  it("shows the warning from $20", async () => {
    await call(19.99);
    expect(await spendState(deps())).toMatchObject({ monthToDateUsd: 19.99, warn: false });

    await call(0.01);
    expect(await spendState(deps())).toMatchObject({ warn: true, newJobsAllowed: true });
  });

  it("refuses new jobs from $25", async () => {
    await call(24.99);
    expect(await spendState(deps())).toMatchObject({ newJobsAllowed: true });

    await call(0.01);
    expect(await spendState(deps())).toMatchObject({ newJobsAllowed: false, callsAllowed: true });
  });

  it("counts a call to a model missing from the price table at the highest rate", async () => {
    // A million tokens each way: $24 at Claude Opus 5.5's rates, and more at the
    // highest rates, which is what the wrapper logs for an unknown model.
    const unknown = costOf(
      { model: "claude-unknown", inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      clock.now(),
    );
    await call(unknown.usd, "2026-10-10T09:00:00Z", { priceKnown: false });

    expect(unknown).toMatchObject({ known: false });
    expect(await spendState(deps())).toMatchObject({ newJobsAllowed: false });
  });
});

describe("spendGuard", () => {
  it("lets calls run below $26, so a job already running can finish", async () => {
    await call(25.99);

    expect(await spendGuard(deps())({ stage: "extract", jobId: null, model: "claude-opus-5-5", provisionalCostUsd: 0.4 })).toEqual({
      ok: true,
    });
  });

  it("refuses every call from $26", async () => {
    await call(26);

    expect(await spendGuard(deps())({ stage: "draft", jobId: null, model: "claude-opus-5-5", provisionalCostUsd: 0.4 })).toEqual({
      ok: false,
      message: expect.stringMatching(/\$26/),
    });
  });
});
