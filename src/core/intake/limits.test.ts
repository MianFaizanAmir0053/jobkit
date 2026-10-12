import { describe, expect, it } from "vitest";

import { type ImageMeta, LIMITS, refusal } from "./limits";

/* The same refusals on the phone and on the server (intake AC3 and AC6). */

const hash = (n: number) => n.toString(16).padStart(64, "0");
const image = (n: number, overrides: Partial<ImageMeta> = {}): ImageMeta => ({
  contentType: "image/webp",
  bytes: 1_000,
  width: 1080,
  height: 2400,
  sha256: hash(n),
  ...overrides,
});

describe("refusal", () => {
  it("lets a job within every limit through", () => {
    expect(refusal([image(1), image(2)], "")).toBeNull();
    expect(refusal([], "We're hiring a React developer.")).toBeNull();
    expect(
      refusal(
        Array.from({ length: LIMITS.images }, (_, n) => image(n)),
        "",
      ),
    ).toBeNull();
  });

  it("refuses an empty job", () => {
    expect(refusal([], "  \n ")).toBe(
      "Nothing to start: choose screenshots of the post, or paste its text.",
    );
  });

  it("refuses a ninth screenshot", () => {
    expect(
      refusal(
        Array.from({ length: 9 }, (_, n) => image(n)),
        "",
      ),
    ).toBe("At most 8 screenshots per job. Remove some, or split the post into two jobs.");
  });

  it("refuses a screenshot over 10 MB once encoded", () => {
    expect(refusal([image(1, { bytes: LIMITS.imageBytes })], "")).toBeNull();
    expect(refusal([image(1, { bytes: LIMITS.imageBytes + 1 })], "")).toBe(
      "A screenshot is larger than 10 MB. Take a smaller screenshot of that part.",
    );
  });

  it("refuses text over 20,000 characters", () => {
    expect(refusal([], "x".repeat(LIMITS.textLength))).toBeNull();
    expect(refusal([], "x".repeat(LIMITS.textLength + 1))).toBe(
      "The pasted text is longer than 20,000 characters. Paste only the job post.",
    );
  });

  it("refuses two 1,080 × 30,000 screenshots, 26 tiles, with the spec's words", () => {
    expect(refusal([image(1, { height: 30_000 }), image(2, { height: 30_000 })], "")).toBe(
      "Too many screenshots for one job. Remove some, or split the post into two jobs.",
    );
  });

  it("counts a size that cannot be cut as over the tile limit", () => {
    expect(refusal([image(1, { width: 3_000 })], "")).toBe(
      "Too many screenshots for one job. Remove some, or split the post into two jobs.",
    );
  });
});
