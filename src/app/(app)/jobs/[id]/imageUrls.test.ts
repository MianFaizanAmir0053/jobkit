import { describe, expect, it } from "vitest";

import { afterFailure, firstShown, MAX_FAILURES, withLatest } from "./imageUrls";

/* Which signed URL one of the post's images loads as the job page is drawn again. */

describe("a post image's URL", () => {
  it("keeps a URL that loaded when the page is drawn again with a new one", () => {
    const shown = firstShown("a");

    expect(withLatest(shown, "b")).toBe(shown);
  });

  it("takes the newest URL the page has when the shown one fails", () => {
    expect(afterFailure(firstShown("a"), "b")).toEqual({
      shown: { src: "b", failed: false, failures: 1 },
      redraw: false,
    });
  });

  it("asks for the page drawn again when it has no newer URL, then takes the one drawn", () => {
    const failed = afterFailure(firstShown("a"), "a");

    expect(failed).toEqual({ shown: { src: "a", failed: true, failures: 1 }, redraw: true });
    // A second error for the same URL asks nothing more.
    expect(afterFailure(failed.shown, "a")).toEqual({ shown: failed.shown, redraw: false });
    expect(withLatest(failed.shown, "a")).toBe(failed.shown);
    expect(withLatest(failed.shown, "b")).toEqual({ src: "b", failed: false, failures: 1 });
  });

  it("stops asking once its URLs have failed MAX_FAILURES times", () => {
    let shown = firstShown("u0");
    for (let i = 1; i < MAX_FAILURES; i++) {
      const failed = afterFailure(shown, shown.src);
      expect(failed.redraw).toBe(true);
      shown = withLatest(failed.shown, `u${i}`);
    }

    const last = afterFailure(shown, shown.src);

    expect(last).toEqual({
      shown: { src: shown.src, failed: true, failures: MAX_FAILURES },
      redraw: false,
    });
    expect(withLatest(last.shown, "newer")).toBe(last.shown);
  });
});
