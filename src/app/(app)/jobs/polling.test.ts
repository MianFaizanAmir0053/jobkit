import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GATE_CHECK_MS,
  JOB_POLL,
  LIST_TICK_MS,
  type PageHooks,
  pollJob,
  refreshList,
  watchGate,
} from "./polling";

/* Polling on the job page and the jobs list (platform spec B9, review spec "Jobs list"), and the kit's gate (review spec, "The outbound gate"). */

function fakePage() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const page: PageHooks = {
    hidden: () => hidden,
    onShown(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => Date.now(),
  };
  return {
    page,
    listeners,
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      for (const listener of listeners) listener();
    },
  };
}

/** An advance the test settles by hand, as a slow server would answer. */
function slowAdvance() {
  const pending: (() => void)[] = [];
  const advance = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
  return { advance, settle: () => pending.splice(0).forEach((resolve) => resolve()) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollJob", () => {
  it("polls every 2 seconds for the first minute, then every 5", async () => {
    const { page } = fakePage();
    const times: number[] = [];
    const start = Date.now();
    const refresh = vi.fn();
    const stop = pollJob(
      async () => {
        times.push(Date.now() - start);
      },
      refresh,
      page,
    );

    await vi.advanceTimersByTimeAsync(80_000);
    stop();

    expect(times.slice(0, 2)).toEqual([JOB_POLL.fastMs, 2 * JOB_POLL.fastMs]);
    const gaps = times.slice(1).map((time, i) => time - times[i]!);
    expect(gaps.at(-1)).toBe(JOB_POLL.slowMs);
    expect(refresh).toHaveBeenCalledTimes(times.length);
  });

  it("never polls while the page is hidden, and polls at once when it is shown again", async () => {
    const { page, hide, show } = fakePage();
    const advance = vi.fn(async () => undefined);
    const stop = pollJob(advance, vi.fn(), page);

    hide();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(advance).not.toHaveBeenCalled();
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(advance).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not render a page hidden while the server worked", async () => {
    const { page, hide } = fakePage();
    const { advance, settle } = slowAdvance();
    const refresh = vi.fn();
    const stop = pollJob(advance, refresh, page);

    await vi.advanceTimersByTimeAsync(JOB_POLL.fastMs);
    expect(advance).toHaveBeenCalledTimes(1);
    hide();
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("runs one poll at a time, however often the page is shown", async () => {
    const { page, show } = fakePage();
    const { advance, settle } = slowAdvance();
    const stop = pollJob(advance, vi.fn(), page);

    await vi.advanceTimersByTimeAsync(JOB_POLL.fastMs);
    show();
    show();
    await vi.advanceTimersByTimeAsync(JOB_POLL.fastMs * 3);
    expect(advance).toHaveBeenCalledTimes(1);
    settle();
    await vi.advanceTimersByTimeAsync(JOB_POLL.fastMs);
    expect(advance).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops polling and listening once stopped", async () => {
    const { page, listeners } = fakePage();
    const advance = vi.fn(async () => undefined);

    pollJob(advance, vi.fn(), page)();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(advance).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});

describe("refreshList", () => {
  it("advances at once when the list opens, then every 10 seconds", async () => {
    const { page } = fakePage();
    const advanceAll = vi.fn(async () => undefined);
    const refresh = vi.fn();
    const stop = refreshList(advanceAll, refresh, page);

    await vi.advanceTimersByTimeAsync(0);
    expect(advanceAll).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIST_TICK_MS);
    expect(advanceAll).toHaveBeenCalledTimes(2);
    stop();
  });

  it("starts no batch for a mount undone at once, as Strict Mode does in development", async () => {
    const { page } = fakePage();
    const advanceAll = vi.fn(async () => undefined);

    refreshList(advanceAll, vi.fn(), page)();
    const stop = refreshList(advanceAll, vi.fn(), page);
    await vi.advanceTimersByTimeAsync(0);

    expect(advanceAll).toHaveBeenCalledTimes(1);
    stop();
  });

  it("skips ticks while one runs or the page is hidden, and ticks when it is shown again", async () => {
    const { page, hide, show } = fakePage();
    const { advance, settle } = slowAdvance();
    const refresh = vi.fn();
    const stop = refreshList(advance, refresh, page);

    await vi.advanceTimersByTimeAsync(LIST_TICK_MS * 2);
    expect(advance).toHaveBeenCalledTimes(1);
    hide();
    settle();
    await vi.advanceTimersByTimeAsync(LIST_TICK_MS * 2);
    // Hidden while the server worked: no render, and no tick until it is shown.
    expect(refresh).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledTimes(1);
    show();
    expect(advance).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("watchGate", () => {
  it("asks the server at once, every 15 seconds while shown, and at once when shown again", async () => {
    const { page, hide, show } = fakePage();
    const read = vi.fn(async () => ({ kit: "K", open: true }));
    const answers: unknown[] = [];

    const stop = watchGate(read, (answer) => answers.push(answer), page);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GATE_CHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
    hide();
    await vi.advanceTimersByTimeAsync(GATE_CHECK_MS * 4);
    expect(read).toHaveBeenCalledTimes(2);
    show();
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(3);
    expect(answers).toEqual([
      { kit: "K", open: true },
      { kit: "K", open: true },
      { kit: "K", open: true },
    ]);
    stop();
  });

  it("asks once at a time, and says nothing once stopped", async () => {
    const { page, show } = fakePage();
    const pending: ((answer: { kit: string; open: boolean }) => void)[] = [];
    const read = vi.fn(
      () => new Promise<{ kit: string; open: boolean }>((resolve) => pending.push(resolve)),
    );
    const settle = vi.fn();

    const stop = watchGate(read, settle, page);
    await vi.advanceTimersByTimeAsync(GATE_CHECK_MS * 3);
    show();
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    pending[0]!({ kit: "K", open: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(settle).not.toHaveBeenCalled();
  });
});
