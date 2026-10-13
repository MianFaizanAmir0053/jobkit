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
      // A page restored from the back-forward cache is shown again too.
      document.addEventListener("visibilitychange", handler);
      window.addEventListener("pageshow", handler);
      return () => {
        document.removeEventListener("visibilitychange", handler);
        window.removeEventListener("pageshow", handler);
      };
    },
    now: () => performance.now(),
  };
}

/** A job's page polls every 2 seconds for its first minute, then every 5. */
export const JOB_POLL = { fastMs: 2_000, slowMs: 5_000, fastForMs: 60_000 } as const;

/** The jobs list advances its running jobs every 10 seconds. */
export const LIST_TICK_MS = 10_000;

/** How long one advance request may take before the poll gives it up, so a stalled one never stops polling. */
export const ADVANCE_TIMEOUT_MS = 15_000;

/** Asks the server to advance a job; settles within ADVANCE_TIMEOUT_MS whatever the network does. */
export function advanceJob(jobId: string): Promise<unknown> {
  return fetch(`/api/jobs/${jobId}/advance`, {
    method: "POST",
    signal: AbortSignal.timeout(ADVANCE_TIMEOUT_MS),
  }).catch(() => undefined);
}

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
 * Keeps the list's running jobs moving: a tick as soon as the page is
 * free, then every 10 seconds and whenever the page is shown again,
 * skipped while one runs. The first tick waits a turn, so a mount that is
 * undone at once (React's Strict Mode does so in development) starts no
 * second batch beside the first. Returns a function that stops it.
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
  const first = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    stopShown();
  };
}

/** A kit's outbound controls ask the server about its gate this often while the page is shown. */
export const GATE_CHECK_MS = 15_000;

/** What the server says of a kit's gate: the kit as it stands, and whether nothing holds it. */
export interface GateAnswer {
  kit: string | null;
  open: boolean;
}

/** Asks the server about a kit's gate; null when it cannot be asked, as when offline. */
export function readGate(jobId: string): Promise<GateAnswer | null> {
  return fetch(`/api/jobs/${jobId}/gate`, {
    cache: "no-store",
    signal: AbortSignal.timeout(ADVANCE_TIMEOUT_MS),
  })
    .then(async (response) => (response.ok ? ((await response.json()) as GateAnswer) : null))
    .catch(() => null);
}

/**
 * Watches a kit's gate for its outbound controls (review spec, "The outbound
 * gate"): asks the server as soon as the page is free, every GATE_CHECK_MS
 * while it is shown and at once when it is shown again, one ask at a time
 * and never while hidden, so a page drawn before the gate closed, in
 * another tab, on the other device or brought back by Back, learns of it.
 * Each answer goes to `settle`, none once stopped. Returns a function that
 * stops it.
 */
export function watchGate<T>(
  read: () => Promise<T>,
  settle: (answer: T) => void,
  page: PageHooks,
): () => void {
  let stopped = false;
  let busy = false;

  const ask = () => {
    if (stopped || busy || page.hidden()) return;
    busy = true;
    void read()
      .then(
        (answer) => {
          if (!stopped) settle(answer);
        },
        () => undefined,
      )
      .finally(() => {
        busy = false;
      });
  };
  const stopShown = page.onShown(ask);
  const timer = setInterval(ask, GATE_CHECK_MS);
  const first = setTimeout(ask, 0);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    stopShown();
  };
}
