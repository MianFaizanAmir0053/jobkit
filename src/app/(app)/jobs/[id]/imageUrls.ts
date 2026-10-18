/**
 * Which signed URL one of the post's images loads on the job page (review
 * spec, "Contact panel"). The page signs its images afresh, for 60 seconds,
 * each time it is drawn, as after each of the owner's answers. An image
 * that loaded keeps its first URL, since the browser has it, so a phone on
 * mobile data does not fetch it again. One that fails, on flaky data or
 * once its URL ran out, takes the newest URL the page has, or has the page
 * drawn again for one; after MAX_FAILURES it stays as it is, so storage
 * that refuses it is not asked for ever.
 */

export const MAX_FAILURES = 3;

/** The page is drawn again for new URLs at most this often, however many of its images fail at once. */
export const REDRAW_GAP_MS = 5_000;

export interface Shown {
  /** The URL the image loads. */
  src: string;
  /** Whether that URL failed to load. */
  failed: boolean;
  /** How many of its URLs failed. */
  failures: number;
}

export function firstShown(src: string): Shown {
  return { src, failed: false, failures: 0 };
}

/** As the page is drawn again with a newly signed URL: one that failed gives way to it, one that loaded stays. */
export function withLatest(shown: Shown, latest: string): Shown {
  return shown.failed && latest !== shown.src && shown.failures < MAX_FAILURES
    ? { src: latest, failed: false, failures: shown.failures }
    : shown;
}

/**
 * When the shown URL fails: the newest URL the page has, when it has a
 * newer one; else the image waits for the page drawn again (`redraw`).
 */
export function afterFailure(shown: Shown, latest: string): { shown: Shown; redraw: boolean } {
  if (shown.failed) return { shown, redraw: false };
  const failures = shown.failures + 1;
  if (failures >= MAX_FAILURES) {
    return { shown: { ...shown, failed: true, failures }, redraw: false };
  }
  if (latest !== shown.src) {
    return { shown: { src: latest, failed: false, failures }, redraw: false };
  }
  return { shown: { ...shown, failed: true, failures }, redraw: true };
}
