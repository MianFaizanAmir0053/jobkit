import sharp from "sharp";

import type { ImageBox } from "@/core/shared/tileGeometry";

import { uprightSize } from "./tiles";

/**
 * The crop the second read of a contact sees (extraction spec, "Stage
 * address_read"): the contact's box on the upright screenshot, with a
 * 40-pixel margin, at least 240 by 64 pixels, kept inside the image, and
 * enlarged twofold so small text reads well.
 */

export const CROP = { margin: 40, minWidth: 240, minHeight: 64, scale: 2 } as const;

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Box = Pick<ImageBox, "x1" | "y1" | "x2" | "y2">;

/**
 * One side of the crop: the box's span with its margins, grown about its
 * centre to the minimum, moved back inside the image when it runs off an
 * edge, and cut to the image when the image is smaller than the minimum.
 */
function span(start: number, end: number, min: number, limit: number): [number, number] {
  let from = start - CROP.margin;
  let to = end + CROP.margin;
  if (to - from < min) {
    const grow = (min - (to - from)) / 2;
    from -= grow;
    to += grow;
  }
  if (from < 0) {
    to -= from;
    from = 0;
  }
  if (to > limit) {
    from -= to - limit;
    to = limit;
  }
  return [Math.max(0, Math.floor(from)), Math.min(limit, Math.ceil(to))];
}

/** Where to cut around a box on an image of this size; null for an empty box or one outside the image. */
export function cropRect(box: Box, image: { width: number; height: number }): CropRect | null {
  const { x1, y1, x2, y2 } = box;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x1 < 0 || y1 < 0 || x2 > image.width || y2 > image.height || x1 >= x2 || y1 >= y2) {
    return null;
  }
  const [left, right] = span(x1, x2, CROP.minWidth, image.width);
  const [top, bottom] = span(y1, y2, CROP.minHeight, image.height);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The crop as PNG, from the image turned upright as the owner saw it (the
 * box was read on the upright image), enlarged twofold. The size comes from
 * the header, and sharp turns, cuts and enlarges in one pipeline, with no
 * copy of the whole image in between. Null when the bytes are not an image
 * or the box does not fit it.
 */
export async function cropContact(bytes: Uint8Array, box: ImageBox): Promise<Uint8Array | null> {
  const size = await uprightSize(bytes);
  const rect = size && cropRect(box, size);
  if (!rect) return null;
  try {
    // Turned upright first, then cut: the order of these calls is the order sharp applies them.
    const crop = await sharp(bytes)
      .autoOrient()
      .extract(rect)
      .resize({ width: rect.width * CROP.scale, height: rect.height * CROP.scale })
      .png()
      .toBuffer();
    return new Uint8Array(crop);
  } catch {
    return null;
  }
}
