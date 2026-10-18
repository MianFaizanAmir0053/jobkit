import { describe, expect, it } from "vitest";

import {
  afterFailure,
  afterLoad,
  AUTO_FETCHES,
  CROP_KEY,
  firstShown,
  urlFor,
  withFresh,
  withLatest,
} from "./imageUrls";

/* Which signed URL one of the post's images loads, as the job page is drawn again or asks afresh. */

describe("a post image's URL", () => {
  it("keeps a URL that loaded when the page is drawn again with a new one", () => {
    const shown = firstShown("a");

    expect(withLatest(shown, "b")).toBe(shown);
  });

  it("takes a newer URL the page was drawn with when the shown one fails", () => {
    expect(afterFailure(firstShown("a"), "b")).toEqual({
      shown: { src: "b", page: "b", failed: false, fetched: 0 },
      fetch: false,
    });
  });

  it("asks for fresh URLs once when the page has no newer one, then waits for the owner", () => {
    const failed = afterFailure(firstShown("a"), "a");
    expect(failed).toEqual({
      shown: { src: "a", page: "a", failed: true, fetched: 0 },
      fetch: true,
    });

    const fresh = withFresh(failed.shown, "b");
    expect(fresh).toEqual({ src: "b", page: "a", failed: false, fetched: AUTO_FETCHES });
    // The fresh URL fails too: the page's older one is not taken back, and nothing more is asked.
    expect(afterFailure(fresh, "a")).toEqual({
      shown: { src: "b", page: "a", failed: true, fetched: AUTO_FETCHES },
      fetch: false,
    });
  });

  it("takes a newer URL the page is drawn with after a fresh one failed", () => {
    const failed = afterFailure(withFresh(afterFailure(firstShown("a"), "a").shown, "b"), "a");

    expect(withLatest(failed.shown, "d")).toEqual({
      src: "d",
      page: "d",
      failed: false,
      fetched: AUTO_FETCHES,
    });
  });

  it("stays failed when no fresh URL comes, and takes one the owner asks for", () => {
    const failed = afterFailure(firstShown("a"), "a").shown;
    const none = withFresh(failed, null);

    expect(none).toEqual({ src: "a", page: "a", failed: true, fetched: 1 });
    expect(withFresh(none, "c")).toEqual({ src: "c", page: "a", failed: false, fetched: 2 });
  });

  it("asks again of its own once an image has loaded since", () => {
    const loaded = afterLoad(withFresh(afterFailure(firstShown("a"), "a").shown, "b"));

    expect(loaded).toEqual({ src: "b", page: "a", failed: false, fetched: 0 });
    expect(afterFailure(loaded, "a").fetch).toBe(true);
  });

  it("gives a second error for the same URL nothing more", () => {
    const failed = afterFailure(firstShown("a"), "a").shown;

    expect(afterFailure(failed, "a")).toEqual({ shown: failed, fetch: false });
  });

  it("picks the crop's or a screenshot's URL from fresh ones", () => {
    const fresh = { crop: "c", screenshots: [{ id: "s1", url: "u1" }] };

    expect(urlFor(fresh, CROP_KEY)).toBe("c");
    expect(urlFor(fresh, "s1")).toBe("u1");
    expect(urlFor(fresh, "s2")).toBeNull();
    expect(urlFor({ crop: null, screenshots: [] }, CROP_KEY)).toBeNull();
  });
});
