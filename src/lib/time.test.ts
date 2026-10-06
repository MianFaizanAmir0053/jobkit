import { describe, expect, it } from "vitest";

import { lastSeen } from "./time";

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
