/**
 * Which signed URL one of the post's images loads on the job page (review
 * spec, "Contact panel"). The page signs its images afresh, for 60 seconds,
 * each time it is drawn, as after each of the owner's answers. An image
 * that loaded keeps its URL, since the browser has it, so a phone on mobile
 * data does not fetch it again. One that fails, on flaky data or once its
 * URL ran out, takes a newer URL the page was drawn with since; else it
 * asks the server for fresh ones, once of its own, through the images
 * route, never by drawing the page again, which on a failing connection
 * Next turns into a reload that loses what the owner typed. After that it
 * waits for the owner's "Load again".
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
  /** Whether the URL it loads failed. */
  failed: boolean;
  /** How many times it asked for fresh URLs since it last loaded. */
  fetched: number;
}

export function firstShown(src: string): Shown {
  return { src, page: src, failed: false, fetched: 0 };
}

/** As the page is drawn again: a newer URL replaces one that failed; one that loaded stays. */
export function withLatest(shown: Shown, latest: string): Shown {
  return shown.failed && latest !== shown.page
    ? { src: latest, page: latest, failed: false, fetched: shown.fetched }
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

/** The fresh URL the server gave for it, or none, as when the connection failed. */
export function withFresh(shown: Shown, url: string | null): Shown {
  return url
    ? { ...shown, src: url, failed: false, fetched: shown.fetched + 1 }
    : { ...shown, failed: true, fetched: shown.fetched + 1 };
}

/** It loaded: a later failure may ask for fresh URLs of its own again. */
export function afterLoad(shown: Shown): Shown {
  return shown.failed || shown.fetched > 0 ? { ...shown, failed: false, fetched: 0 } : shown;
}

/** The crop's or a screenshot's URL among fresh ones; null when the server gave none. */
export function urlFor(fresh: FreshImages, key: string): string | null {
  if (key === CROP_KEY) return fresh.crop;
  return fresh.screenshots.find((shot) => shot.id === key)?.url ?? null;
}
