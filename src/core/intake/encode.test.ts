import { describe, expect, it } from "vitest";

import { encodingFor, prepareSize, TOO_TALL } from "./encode";

/* Intake AC2's decisions; the browser does the decoding and encoding itself. */

describe("prepareSize", () => {
  it("keeps a phone screenshot's resolution, however tall", () => {
    expect(prepareSize(1080, 6000)).toEqual({ ok: true, width: 1080, height: 6000 });
  });

  it("scales an image wider than 2,576 pixels down to 2,576, keeping its proportions", () => {
    expect(prepareSize(3000, 1500)).toEqual({ ok: true, width: 2576, height: 1288 });
  });

  it("refuses an image taller than 30,000 pixels once scaled", () => {
    expect(prepareSize(1080, 31000)).toEqual({ ok: false, message: TOO_TALL });
    expect(prepareSize(1080, 30000)).toMatchObject({ ok: true });
    // 5,152 × 60,000 scales to 2,576 × 30,000, which fits.
    expect(prepareSize(5152, 60000)).toEqual({ ok: true, width: 2576, height: 30000 });
  });

  it("refuses the message the spec gives", () => {
    expect(TOO_TALL).toBe("Too tall. Take two shorter screenshots instead.");
  });
});

describe("encodingFor", () => {
  it("encodes as WebP at 0.9 when both sides fit WebP's limit, and as JPEG at 0.92 otherwise", () => {
    expect(encodingFor(1080, 16383)).toEqual({ type: "image/webp", quality: 0.9 });
    expect(encodingFor(1080, 20000)).toEqual({ type: "image/jpeg", quality: 0.92 });
  });
});
