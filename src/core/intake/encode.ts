import { MAX_LONG_EDGE } from "@/core/shared/tileGeometry";

import { LIMITS, TOO_TALL } from "./limits";

/**
 * How the phone prepares each image before it uploads (intake spec, "Upload
 * path"): at its native resolution, so tall scrolling screenshots stay tall
 * and extraction cuts them into tiles; only an image wider than 2,576 pixels,
 * which phones do not produce, is scaled down to that width. WebP at 0.9
 * where both sides are within WebP's limit, JPEG at 0.92 otherwise. The
 * browser decodes and encodes; this module only decides, so it is tested.
 */

const WEBP_MAX_SIDE = 16_383;

export { TOO_TALL };

export type PreparedSize =
  { ok: true; width: number; height: number } | { ok: false; message: string };

export function prepareSize(width: number, height: number): PreparedSize {
  const scale = width > MAX_LONG_EDGE ? MAX_LONG_EDGE / width : 1;
  // The limit applies to the image as uploaded, which is what extraction cuts.
  const prepared = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  return prepared.height > LIMITS.height
    ? { ok: false, message: TOO_TALL }
    : { ok: true, ...prepared };
}

export function encodingFor(
  width: number,
  height: number,
): { type: "image/webp" | "image/jpeg"; quality: number } {
  return width <= WEBP_MAX_SIDE && height <= WEBP_MAX_SIDE
    ? { type: "image/webp", quality: 0.9 }
    : { type: "image/jpeg", quality: 0.92 };
}
