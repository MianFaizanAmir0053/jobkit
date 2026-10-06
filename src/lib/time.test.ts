import { describe, expect, it } from "vitest";

import { formatDuration, lastSeen } from "./time";

const NOW = new Date("2026-10-06T12:00:00Z");
const before = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

describe("lastSeen", () => {
  it("says within the last hour, since last-seen times only move hourly", () => {
    expect(lastSeen(before(0), NOW)).toBe("within the last hour");
    expect(lastSeen(before(HOUR - 1), NOW)).toBe("within the last hour");
  });

  it("counts whole hours, then whole days", () => {
    expect(lastSeen(before(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(lastSeen(before(24 * HOUR), NOW)).toBe("yesterday");
    expect(lastSeen(before(5 * 24 * HOUR + HOUR), NOW)).toBe("5 days ago");
  });
});

describe("formatDuration", () => {
  it("shows minutes and seconds, and hours once there are any", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(59 * 60_000 + 59_999)).toBe("59:59");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
  });
});
