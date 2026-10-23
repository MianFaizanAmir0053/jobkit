import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirms,
  GATE_CHECK_MS,
  type GateAnswer,
  holdOutbound,
  JOB_POLL,
  LIST_TICK_MS,
  onOutboundHold,
  outboundHeld,
  type PageHooks,
  pollJob,
  pollsStatus,
  refreshList,
  watchGate,
} from "./polling";
import { JOB_STATES, kindOf } from "@/core/platform/jobStates";

/* Polling on the job page and the jobs list (platform spec B9, review spec "Jobs list"), and the kit's gate (review spec, "The outbound gate"). */

function fakePage() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const hiding = new Set<() => void>();
  const page: PageHooks = {
    hidden: () => hidden,
    onShown(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onHidden(listener) {
      hiding.add(listener);
      return () => hiding.delete(listener);
    },
    now: () => Date.now(),
  };
  return {
    page,
    listeners,
    hide: () => {
      hidden = true;
      for (const listener of hiding) listener();
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
    const read = vi.fn(async () => ({
      kit: "K",
      open: true,
      to: "jobs@example.com",
      status: null,
    }));
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
      { kit: "K", open: true, to: "jobs@example.com", status: null },
      { kit: "K", open: true, to: "jobs@example.com", status: null },
      { kit: "K", open: true, to: "jobs@example.com", status: null },
    ]);
    stop();
  });

  it("asks once at a time, and says nothing once stopped", async () => {
    const { page, show } = fakePage();
    const pending: ((answer: GateAnswer) => void)[] = [];
    const read = vi.fn(() => new Promise<GateAnswer>((resolve) => pending.push(resolve)));
    const settle = vi.fn();

    const stop = watchGate(read, settle, page);
    await vi.advanceTimersByTimeAsync(GATE_CHECK_MS * 3);
    show();
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    pending[0]!({ kit: "K", open: true, to: "jobs@example.com", status: null, words: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(settle).not.toHaveBeenCalled();
  });

  it("forgets its last answer as soon as the page is hidden, so a page shown again waits for a new one", async () => {
    const { page, hide, show } = fakePage();
    const read = vi.fn(async () => ({
      kit: "K",
      open: true,
      to: "jobs@example.com",
      status: null,
    }));
    const forget = vi.fn();

    const stop = watchGate(read, () => undefined, page, { forget });
    await vi.advanceTimersByTimeAsync(0);
    hide();
    expect(forget).toHaveBeenCalledTimes(1);
    show();
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("drops an answer asked for before the page was hidden", async () => {
    const { page, hide, show } = fakePage();
    const pending: ((answer: GateAnswer) => void)[] = [];
    const read = vi.fn(() => new Promise<GateAnswer>((resolve) => pending.push(resolve)));
    const settle = vi.fn();

    const stop = watchGate(read, settle, page, { forget: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    hide();
    pending[0]!({ kit: "K", open: true, to: "jobs@example.com", status: null, words: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).not.toHaveBeenCalled();
    show();
    await vi.advanceTimersByTimeAsync(0);
    pending[1]!({ kit: "K", open: false, to: "jobs@example.com", status: null, words: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(settle.mock.calls).toEqual([
      [{ kit: "K", open: false, to: "jobs@example.com", status: null, words: null }],
    ]);
    stop();
  });

  it("forgets and asks at once when told the gate changed, dropping an answer asked for before", async () => {
    const { page, hide } = fakePage();
    const nudges = new Set<() => void>();
    const nudge = () => nudges.forEach((listener) => listener());
    const pending: ((answer: GateAnswer) => void)[] = [];
    const read = vi.fn(() => new Promise<GateAnswer>((resolve) => pending.push(resolve)));
    const settle = vi.fn();
    const forget = vi.fn();
    const nudged = (listener: () => void) => {
      nudges.add(listener);
      return () => nudges.delete(listener);
    };

    const stop = watchGate(read, settle, page, { forget, nudged });
    await vi.advanceTimersByTimeAsync(0);
    nudge();
    expect(forget).toHaveBeenCalledTimes(1);
    // The answer to the ask made before the change says nothing of the gate now: it is asked again.
    pending[0]!({ kit: "K", open: true, to: "jobs@example.com", status: null, words: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    pending[1]!({ kit: "K", open: true, to: "careers@example.com", status: null, words: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(settle.mock.calls).toEqual([
      [{ kit: "K", open: true, to: "careers@example.com", status: null, words: null }],
    ]);
    hide();
    nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);

    stop();
    expect(nudges.size).toBe(0);
  });
});

describe("pollsStatus", () => {
  it("asks a job's status only while it runs or uploads, never a ready, waiting, owner or final job's (platform AC19)", () => {
    const polled = JOB_STATES.filter((state) => pollsStatus(kindOf(state)));

    expect(polled).toEqual(
      JOB_STATES.filter((state) => ["running", "client"].includes(kindOf(state))),
    );
    for (const state of [
      "kit_ready",
      "needs_role_pick",
      "failed",
      "manual_run",
      "closed",
    ] as const) {
      expect(pollsStatus(kindOf(state)), state).toBe(false);
    }
  });
});

describe("confirms", () => {
  it("takes the server's answer as the page's only for the same kit, gate, address and status", () => {
    const shown = {
      kit: "K",
      open: true,
      to: "jobs@example.com",
      status: "kit_ready",
      words: "W",
    };

    expect(confirms(shown, shown)).toBe(true);
    // The owner edited a sentence in another tab: this page's words are not the kit's.
    expect(confirms({ ...shown, words: "X" }, shown)).toBe(false);
    expect(confirms({ ...shown, to: "careers@example.com" }, shown)).toBe(false);
    expect(confirms({ ...shown, kit: "L" }, shown)).toBe(false);
    expect(confirms({ ...shown, open: false }, shown)).toBe(false);
    // Skipped or bounced since, or taken back since: the page shows another, the gate closed
    // throughout.
    expect(confirms({ ...shown, open: false, status: "skipped" }, { ...shown, open: false })).toBe(
      false,
    );
    expect(
      confirms(
        { ...shown, open: false, status: "bounced" },
        { ...shown, open: false, status: "sent" },
      ),
    ).toBe(false);
    expect(confirms(null, shown)).toBe(false);
  });
});

describe("holdOutbound", () => {
  it("holds the outbound controls while any decision is in flight, each release counting once", () => {
    const changes = vi.fn();
    const stop = onOutboundHold(changes);

    const first = holdOutbound();
    const second = holdOutbound();
    first();
    first();
    expect(outboundHeld()).toBe(true);
    second();

    expect(outboundHeld()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(4);
    stop();
  });
});
