import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import {
  baselineSummary,
  discardBaselineRun,
  startBaselineRun,
  stopBaselineRun,
  type BaselineRoute,
} from "./baseline";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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
  await db.exec("delete from {{schema}}.baseline_runs");
  clock = fakeClock();
});

async function timed(
  ms: number,
  route: BaselineRoute = "email",
  company = "Contoso",
): Promise<void> {
  await startBaselineRun(deps());
  clock.advance(ms);
  const stopped = await stopBaselineRun(deps(), { route, company, role: "Backend Engineer" });
  if (!stopped.ok) throw new Error("expected the run to stop");
}

describe("startBaselineRun", () => {
  it("starts the stopwatch at the server's time", async () => {
    const started = await startBaselineRun(deps());

    expect(started).toMatchObject({ ok: true, run: { startedAt: clock.now(), stoppedAt: null } });
  });

  it("runs one stopwatch at a time", async () => {
    await startBaselineRun(deps());

    expect(await startBaselineRun(deps())).toEqual({ ok: false, reason: "already-running" });
  });
});

describe("stopBaselineRun", () => {
  it("records the route, company and role, trimmed", async () => {
    await startBaselineRun(deps());
    clock.advance(7 * MINUTE + 30 * SECOND);

    const stopped = await stopBaselineRun(deps(), {
      route: "form",
      company: "  Contoso Ltd ",
      role: " Data Engineer",
    });

    expect(stopped).toMatchObject({
      ok: true,
      run: { route: "form", company: "Contoso Ltd", role: "Data Engineer", durationMs: 450_000 },
    });
  });

  it("refuses when no stopwatch is running", async () => {
    expect(
      await stopBaselineRun(deps(), { route: "email", company: "Contoso", role: "Engineer" }),
    ).toEqual({ ok: false, reason: "not-running" });
  });

  it("refuses an empty company or role, and keeps the stopwatch running", async () => {
    await startBaselineRun(deps());

    for (const input of [
      { route: "email", company: " ", role: "Engineer" },
      { route: "email", company: "Contoso", role: "" },
      { route: "email", company: "x".repeat(201), role: "Engineer" },
    ] as const) {
      expect(await stopBaselineRun(deps(), input)).toEqual({ ok: false, reason: "invalid" });
    }
    expect((await baselineSummary(deps())).running).not.toBeNull();
  });
});

describe("discardBaselineRun", () => {
  it("throws away a stopwatch started by mistake, recording nothing", async () => {
    await startBaselineRun(deps());

    expect(await discardBaselineRun(deps())).toBe(true);
    expect(await baselineSummary(deps())).toMatchObject({ running: null, count: 0 });
    expect(await discardBaselineRun(deps())).toBe(false);
  });
});

describe("baselineSummary", () => {
  it("gives the count, median and 90th percentile of the stopped runs, pooled and per route", async () => {
    for (const minutes of [4, 6, 8, 10]) await timed(minutes * MINUTE, "email");
    await timed(20 * MINUTE, "form");

    const summary = await baselineSummary(deps());

    expect(summary).toMatchObject({
      running: null,
      count: 5,
      medianMs: 8 * MINUTE,
      p90Ms: 16 * MINUTE,
      byRoute: {
        email: { count: 4, medianMs: 7 * MINUTE, p90Ms: 9.4 * MINUTE },
        form: { count: 1, medianMs: 20 * MINUTE, p90Ms: 20 * MINUTE },
        message: { count: 0, medianMs: null, p90Ms: null },
      },
    });
  });

  it("leaves a running stopwatch out of the numbers but reports it", async () => {
    await timed(5 * MINUTE);
    await startBaselineRun(deps());
    clock.advance(MINUTE);

    const summary = await baselineSummary(deps());

    expect(summary.count).toBe(1);
    expect(summary.running).toMatchObject({ stoppedAt: null });
    expect(summary.runningForMs).toBe(MINUTE);
  });

  it("lists the latest runs first", async () => {
    await timed(MINUTE, "email", "First");
    await timed(MINUTE, "message", "Second");

    const { recent } = await baselineSummary(deps());

    expect(recent.map((run) => run.company)).toEqual(["Second", "First"]);
  });
});
