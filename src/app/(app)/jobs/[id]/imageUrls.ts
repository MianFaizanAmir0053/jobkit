/**
 * Which signed URL one of the post's images loads on the job page (review
 * spec, "Contact panel"). The page signs its images afresh, for 60 seconds,
 * each time it is drawn, as after each of the owner's answers. An image
 * that loaded, or is loading, keeps its URL, so a phone on mobile data
 * does not fetch it again; one that has not started, as in a closed list,
 * takes the newest, so it does not start on one that ran out. One that
 * fails takes a newer URL the page was drawn with since; else it asks the
 * server for fresh ones, once of its own, through the images route, never
 * by drawing the page again, which on a failing connection Next turns
 * into a reload that loses what the owner typed. The answer goes to every
 * image of the page, each taking it if it failed or has not started, and
 * the one that asked, as when it was slow, in any case. After that a
 * failed image waits for the owner's "Load again".
 */

/** How many times a failed image asks for fresh URLs of its own, between loads. */
export const AUTO_FETCHES = 1;

/** The crop's key among the page's images; a screenshot's is its row's ID. */
export const CROP_KEY = "crop";

/** The images route's answer: the page's images, signed afresh. */
export interface FreshImages {
  crop: string | null;
  screenshots: readonly { id: string; url: string }[];
}

export interface Shown {
  /** The URL the image loads. */
  src: string;
  /** The page's URL for it when it last took one from the page, so only a newer one replaces it. */
  page: string;
  /** Whether the URL it loads has loaded. */
  loaded: boolean;
  /** Whether the URL it loads failed. */
  failed: boolean;
  /** Whether it asked for fresh URLs and takes the answer, failed or not. */
  wants: boolean;
  /** How many times it asked for fresh URLs since it last loaded. */
  fetched: number;
}

export function firstShown(src: string): Shown {
  return { src, page: src, loaded: false, failed: false, wants: false, fetched: 0 };
}

/**
 * As the page is drawn again: a newer URL replaces one that failed, or,
 * for an image that has not started loading, one that has not loaded.
 */
export function withLatest(shown: Shown, latest: string, notStarted: boolean): Shown {
  const replaced = shown.failed || (notStarted && !shown.loaded);
  return replaced && latest !== shown.page
    ? { ...shown, src: latest, page: latest, failed: false }
    : shown;
}

/**
 * When the URL it loads fails: a newer URL the page was drawn with, when
 * there is one; else `fetch` says whether to ask for fresh ones of its own.
 */
export function afterFailure(shown: Shown, latest: string): { shown: Shown; fetch: boolean } {
  if (shown.failed) return { shown, fetch: false };
  if (latest !== shown.page) {
    return { shown: { ...shown, src: latest, page: latest, failed: false }, fetch: false };
  }
  return { shown: { ...shown, failed: true }, fetch: shown.fetched < AUTO_FETCHES };
}

/** It asked for fresh URLs: it takes the answer, failed or not. */
export function asked(shown: Shown): Shown {
  return { ...shown, wants: true, fetched: shown.fetched + 1 };
}

/**
 * The server's fresh URL for it, whichever image asked: taken by one that
 * asked, failed or has not started; none, or the URL it already has, which
 * would load nothing new, leaves it as it was.
 */
export function withAnswer(shown: Shown, url: string | null, notStarted: boolean): Shown {
  const takes = shown.wants || shown.failed || (notStarted && !shown.loaded);
  if (!takes) return shown;
  if (url === null || url === shown.src) return shown.wants ? { ...shown, wants: false } : shown;
  return { ...shown, src: url, failed: false, wants: false };
}

/** It loaded: a later failure may ask for fresh URLs of its own again. */
export function afterLoad(shown: Shown): Shown {
  return shown.loaded && !shown.failed && shown.fetched === 0
    ? shown
    : { ...shown, loaded: true, failed: false, fetched: 0 };
}

/** The crop's or a screenshot's URL among fresh ones; null when the server gave none. */
export function urlFor(fresh: FreshImages, key: string): string | null {
  if (key === CROP_KEY) return fresh.crop;
  return fresh.screenshots.find((shot) => shot.id === key)?.url ?? null;
}
