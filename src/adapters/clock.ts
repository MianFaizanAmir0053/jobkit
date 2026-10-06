import type { Clock } from "@/core/ports";

export const systemClock: Clock = { now: () => new Date() };

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

/** A clock tests move by hand, so lifetimes and timeouts need no waiting. */
export function fakeClock(start: Date = new Date("2026-10-06T09:00:00Z")): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}
