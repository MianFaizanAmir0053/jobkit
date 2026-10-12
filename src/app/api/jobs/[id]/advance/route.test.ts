import { describe, expect, it } from "vitest";

import { RUNNER_LIMITS } from "@/core/platform/runner";

import { maxDuration } from "./route";

describe("the advance route's time limit", () => {
  it("lets the runner's share of an invocation fit, and ends before the lease lapses", () => {
    // A killed invocation's lease must lapse after it, so no two invocations ever run one job.
    expect(RUNNER_LIMITS.invocationMs).toBeLessThan(maxDuration * 1000);
    expect(maxDuration * 1000).toBeLessThan(RUNNER_LIMITS.leaseMs);
  });
});
