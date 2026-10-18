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
  /** Calls `listener` each time the page is hidden or left; returns a function that stops it. */
  onHidden(listener: () => void): () => void;
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
    onHidden(listener) {
      const handler = () => {
        if (document.hidden) listener();
      };
      // A page put in the back-forward cache is left without being hidden first.
      document.addEventListener("visibilitychange", handler);
      window.addEventListener("pagehide", listener);
      return () => {
        document.removeEventListener("visibilitychange", handler);
        window.removeEventListener("pagehide", listener);
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

/**
 * What the server says of a kit's gate: the kit as it stands, whether
 * nothing holds it, the address or number it goes to, and the status of
 * the role's application, null before there is one.
 */
export interface GateAnswer {
  kit: string | null;
  open: boolean;
  to: string | null;
  status: string | null;
  /** The email's words as a short key: an edit in another tab changes them. */
  words: string | null;
}

/**
 * Whether the server's answer is the page's: the same kit, the same gate,
 * the same address, the same status and the same words, so a page drawn
 * before an edit in another tab hands none of its words off, a page showing an address the
 * owner has since typed again elsewhere is never taken as confirmed, and a
 * page drawn before a skip or a bounce, or before either was taken back,
 * is drawn again though the gate stays closed.
 */
export function confirms(answer: GateAnswer | null, shown: GateAnswer): boolean {
  return (
    answer !== null &&
    answer.kit === shown.kit &&
    answer.open === shown.open &&
    answer.to === shown.to &&
    answer.status === shown.status &&
    answer.words === shown.words
  );
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
 * The moment the page is hidden, or `nudged` says the gate changed, as when
 * a decision is made in this tab or another, the last answer is forgotten
 * and an answer to an ask made before is dropped: until a new one comes, a
 * page holds what it shows. Each answer goes to `settle`, none once
 * stopped. Returns a function that stops it.
 */
export function watchGate<T>(
  read: () => Promise<T>,
  settle: (answer: T) => void,
  page: PageHooks,
  hooks: {
    forget?: () => void;
    nudged?: (listener: () => void) => () => void;
  } = {},
): () => void {
  let stopped = false;
  let busy = false;
  // Bumped whenever an answer could be stale: only one to an ask made since counts.
  let wanted = 0;

  const ask = () => {
    if (stopped || busy || page.hidden()) return;
    busy = true;
    const asked = wanted;
    void read()
      .then(
        (answer) => {
          if (!stopped && asked === wanted) settle(answer);
        },
        () => undefined,
      )
      .finally(() => {
        busy = false;
        if (asked !== wanted) ask();
      });
  };
  const forget = () => {
    wanted++;
    hooks.forget?.();
  };
  const stopShown = page.onShown(ask);
  const stopHidden = page.onHidden(forget);
  const stopNudged =
    hooks.nudged?.(() => {
      forget();
      ask();
    }) ?? (() => undefined);
  const timer = setInterval(ask, GATE_CHECK_MS);
  const first = setTimeout(ask, 0);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    stopShown();
    stopHidden();
    stopNudged();
  };
}

const gateChannel = (jobId: string) => `jobkit-gate-${jobId}`;

/**
 * Tells the job's pages in this browser, this tab's and any other's, that
 * its gate may have changed, so their outbound controls wait for the server
 * at once rather than at their next check.
 */
export function gateChanged(jobId: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(gateChannel(jobId));
  channel.postMessage("changed");
  channel.close();
}

/** Listens for gateChanged on the job, for watchGate's `nudged`. */
export function gateNudges(jobId: string): (listener: () => void) => () => void {
  return (listener) => {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    const channel = new BroadcastChannel(gateChannel(jobId));
    channel.onmessage = () => listener();
    return () => channel.close();
  };
}

/** Decisions in flight from this tab: while any is, its outbound controls wait. */
let inFlight = 0;
const holdListeners = new Set<() => void>();

/**
 * Holds this tab's outbound controls while a decision is in flight, so
 * nothing goes out on what the page showed before it, such as an address
 * the owner is typing again. Returns its release, which counts once.
 */
export function holdOutbound(): () => void {
  inFlight++;
  holdListeners.forEach((listener) => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight--;
    holdListeners.forEach((listener) => listener());
  };
}

export const outboundHeld = () => inFlight > 0;

/** Calls `listener` whenever a hold starts or ends; returns a function that stops it. */
export function onOutboundHold(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => {
    holdListeners.delete(listener);
  };
}
