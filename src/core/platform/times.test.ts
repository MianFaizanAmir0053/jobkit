import { describe, expect, it } from "vitest";

import type { JobState } from "./jobStates";
import { jobTimes } from "./times";

const T0 = Date.parse("2026-10-11T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const change = (to: JobState, seconds: number) => ({ to, at: at(seconds) });
const lease = (from: number, to: number) => ({ claimedAt: at(from), endsAt: at(to) });
const run = (from: number, to: number | null) => ({
  startedAt: at(from),
  endedAt: to === null ? null : at(to),
});

describe("jobTimes", () => {
  it("runs machine time from the phone's start to the first kit_ready, counting upload and short poll gaps", () => {
    const times = jobTimes({
      start: at(0),
      changes: [
        change("uploading", 4),
        change("queued", 10),
        change("extracting", 10),
        change("checking", 30),
        change("drafting", 31),
        change("judging", 50),
        change("kit_ready", 60),
      ],
      // The first invocation ran out of time at 40 s; the next poll claimed the job 3 s later.
      leases: [lease(10, 40), lease(43, 60)],
      runs: [],
    });

    expect(times).toEqual({ machineMs: 60_000, pausedMs: 0, processingMs: 0 });
  });

  it("leaves out waiting and owner states, and reports what unpolled gaps run past 10 seconds as paused", () => {
    const times = jobTimes({
      start: at(0),
      changes: [
        change("uploading", 0),
        change("queued", 5),
        change("extracting", 5),
        change("needs_role_pick", 20),
        change("checking", 80),
        change("failed", 110),
        change("checking", 300),
        change("drafting", 330),
        change("judging", 335),
        change("kit_ready", 345),
      ],
      // Nothing polled for 25 s after the role pick, nor for 25 s after the retry.
      leases: [lease(5, 20), lease(105, 110), lease(325, 345)],
      runs: [],
    });

    expect(times).toEqual({
      // Uploading 5 and extracting 15; then checking 30 and 45 after the retry, each less the
      // 15 s its gap ran past a poll's 10; the role pick's 60 and the failed state's 190 count nowhere.
      machineMs: (5 + 15 + 15 + 30) * 1000,
      pausedMs: (15 + 15) * 1000,
      processingMs: 0,
    });
  });

  it("counts a slow poll's gap with its request time as machine time, and pauses only what runs past 10 seconds", () => {
    const times = jobTimes({
      start: at(0),
      changes: [change("uploading", 0), change("queued", 0), change("kit_ready", 130)],
      // After a minute the page polls every 5 s; one claim came 7 s after a release, one 12.4 s.
      leases: [lease(0, 60), lease(67, 90), lease(102.4, 130)],
      runs: [],
    });

    expect(times).toMatchObject({ machineMs: 127_600, pausedMs: 2_400 });
  });

  it("ends at the first kit_ready, however often the job runs again", () => {
    const times = jobTimes({
      start: at(0),
      changes: [
        change("uploading", 0),
        change("queued", 2),
        change("extracting", 2),
        change("checking", 20),
        change("drafting", 21),
        change("judging", 40),
        change("kit_ready", 50),
        change("drafting", 500),
        change("judging", 520),
        change("kit_ready", 530),
      ],
      leases: [lease(2, 50), lease(500, 530)],
      runs: [run(2, 20), run(500, 520)],
    });

    expect(times).toEqual({ machineMs: 50_000, pausedMs: 0, processingMs: 18_000 });
  });

  it("counts concurrent stage runs once in processing time", () => {
    const times = jobTimes({
      start: at(0),
      changes: [change("uploading", 0), change("queued", 1), change("kit_ready", 100)],
      leases: [lease(1, 100)],
      runs: [run(10, 20), run(20, 35), run(21, 30), run(22, 40), run(60, 60), run(70, null)],
    });

    // 10 to 40 once, the reuse at 60 takes no time, and a run still started has none yet.
    expect(times?.processingMs).toBe(30_000);
  });

  it("has no times before the first kit_ready", () => {
    expect(
      jobTimes({
        start: at(0),
        changes: [change("uploading", 0), change("queued", 3), change("extracting", 3)],
        leases: [lease(3, 30)],
        runs: [run(3, 30)],
      }),
    ).toBeNull();
  });
});
