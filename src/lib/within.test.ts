import { afterEach, describe, expect, it, vi } from "vitest";

import { within } from "./within";

/* A step that may hang, given a limit: one-click send's delivery steps (decisions A20). */

afterEach(() => {
  vi.useRealTimers();
});

describe("within", () => {
  it("gives the promise's value when it settles in time", async () => {
    expect(await within(Promise.resolve(7), 1_000, "Reading the CV")).toBe(7);
    await expect(within(Promise.reject(new Error("gone")), 1_000, "Reading")).rejects.toThrow(
      "gone",
    );
  });

  it("throws, naming the step, once the limit passes first", async () => {
    vi.useFakeTimers();
    const waiting = within(new Promise(() => {}), 15_000, "Reading the CV");
    const failed = expect(waiting).rejects.toThrow("Reading the CV took longer than 15 seconds");

    await vi.advanceTimersByTimeAsync(15_000);

    await failed;
  });
});
