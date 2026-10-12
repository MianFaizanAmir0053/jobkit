/**
 * How the job page and the jobs list keep running jobs moving (platform spec
 * B9): each tick asks the server to advance, then renders the page again
 * from the server. Never while the page is hidden, one tick at a time, and
 * at once when the page is shown again. Plain functions over a page's
 * hooks, so tests can drive them with fake timers.
 */

export interface PageHooks {
  hidden(): boolean;
  /** Calls `listener` each time the page is shown again; returns a function that stops it. */
  onShown(listener: () => void): () => void;
  /** Milliseconds from any fixed point. */
  now(): number;
}

/** The browser's page: its visibility and its clock. */
export function browserPage(): PageHooks {
  return {
    hidden: () => document.hidden,
    onShown(listener) {
      const handler = () => {
        if (!document.hidden) listener();
      };
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
    now: () => performance.now(),
  };
}

/** A job's page polls every 2 seconds for its first minute, then every 5. */
export const JOB_POLL = { fastMs: 2_000, slowMs: 5_000, fastForMs: 60_000 } as const;

/** The jobs list advances its running jobs every 10 seconds. */
export const LIST_TICK_MS = 10_000;

/**
 * Polls one job: the first poll after the first interval, each next one an
 * interval after the last ends. Returns a function that stops it.
 */
export function pollJob(
  advance: () => Promise<unknown>,
  refresh: () => void,
  page: PageHooks,
): () => void {
  const since = page.now();
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    const delay = page.now() - since < JOB_POLL.fastForMs ? JOB_POLL.fastMs : JOB_POLL.slowMs;
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      if (!page.hidden()) {
        await advance().catch(() => undefined);
        // The page may have been hidden while the server worked.
        if (!stopped && !page.hidden()) refresh();
      }
    } finally {
      polling = false;
      schedule();
    }
  };
  const stopShown = page.onShown(() => {
    if (stopped || polling) return;
    clearTimeout(timer);
    void tick();
  });

  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopShown();
  };
}

/**
 * Keeps the list's running jobs moving: a tick at once, then every 10
 * seconds and whenever the page is shown again, skipped while one runs.
 * Returns a function that stops it.
 */
export function refreshList(
  advanceAll: () => Promise<unknown>,
  refresh: () => void,
  page: PageHooks,
): () => void {
  let stopped = false;
  let busy = false;

  const tick = () => {
    if (stopped || busy || page.hidden()) return;
    busy = true;
    void advanceAll()
      .catch(() => undefined)
      .finally(() => {
        busy = false;
        if (!stopped && !page.hidden()) refresh();
      });
  };
  const stopShown = page.onShown(tick);
  const timer = setInterval(tick, LIST_TICK_MS);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    stopShown();
  };
}
