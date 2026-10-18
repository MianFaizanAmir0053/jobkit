import { describe, expect, it } from "vitest";

import {
  afterFailure,
  afterLoad,
  asked,
  AUTO_FETCHES,
  CROP_KEY,
  firstShown,
  urlFor,
  withAnswer,
  withLatest,
} from "./imageUrls";

/* Which signed URL one of the post's images loads, as the job page is drawn again or asks afresh. */

describe("a post image's URL", () => {
  it("keeps a URL that loaded, or is loading, when the page is drawn again with a new one", () => {
    const loading = firstShown("a");
    const loaded = afterLoad(loading);

    expect(withLatest(loading, "b", false)).toBe(loading);
    expect(withLatest(loaded, "b", true)).toBe(loaded);
  });

  it("takes the page's newest URL for an image that has not started loading, as one in a closed list", () => {
    expect(withLatest(firstShown("a"), "b", true)).toEqual({
      src: "b",
      page: "b",
      loaded: false,
      failed: false,
      wants: false,
      fetched: 0,
    });
  });

  it("takes a newer URL the page was drawn with when the shown one fails", () => {
    expect(afterFailure(firstShown("a"), "b")).toEqual({
      shown: { src: "b", page: "b", loaded: false, failed: false, wants: false, fetched: 0 },
      fetch: false,
    });
  });

  it("asks for fresh URLs once when the page has no newer one, then waits for the owner", () => {
    const failed = afterFailure(firstShown("a"), "a");
    expect(failed.fetch).toBe(true);
    expect(failed.shown).toMatchObject({ src: "a", failed: true });

    const answered = withAnswer(asked(failed.shown), "b", false);
    expect(answered).toEqual({
      src: "b",
      page: "a",
      loaded: false,
      failed: false,
      wants: false,
      fetched: AUTO_FETCHES,
    });
    // The fresh URL fails too: the page's older one is not taken back, and nothing more is asked.
    expect(afterFailure(answered, "a")).toEqual({
      shown: { ...answered, failed: true },
      fetch: false,
    });
  });

  it("takes a newer URL the page is drawn with after a fresh one failed", () => {
    const failed = afterFailure(
      withAnswer(asked(afterFailure(firstShown("a"), "a").shown), "b", false),
      "a",
    ).shown;

    expect(withLatest(failed, "d", false)).toMatchObject({ src: "d", page: "d", failed: false });
  });

  it("stays failed when the answer has no URL for it, or the same one, which would load nothing", () => {
    const failed = asked(afterFailure(firstShown("a"), "a").shown);

    expect(withAnswer(failed, null, false)).toMatchObject({ src: "a", failed: true, wants: false });
    expect(withAnswer(failed, "a", false)).toMatchObject({ src: "a", failed: true, wants: false });
  });

  it("takes an answer another image asked for only when it failed or has not started", () => {
    const loading = firstShown("a");
    const failed = afterFailure(loading, "a").shown;

    expect(withAnswer(loading, "b", false)).toBe(loading);
    expect(withAnswer(loading, "b", true)).toMatchObject({ src: "b", failed: false });
    expect(withAnswer(failed, "b", false)).toMatchObject({ src: "b", failed: false });
    expect(withAnswer(afterLoad(loading), "b", true)).toEqual(afterLoad(loading));
  });

  it("takes the answer it asked for while slow, though it had not failed", () => {
    expect(withAnswer(asked(firstShown("a")), "b", false)).toMatchObject({
      src: "b",
      wants: false,
    });
  });

  it("asks again of its own once an image has loaded since", () => {
    const loaded = afterLoad(
      withAnswer(asked(afterFailure(firstShown("a"), "a").shown), "b", false),
    );

    expect(loaded).toMatchObject({ src: "b", loaded: true, failed: false, fetched: 0 });
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
