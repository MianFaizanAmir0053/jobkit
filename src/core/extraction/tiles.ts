import sharp, { type Metadata, type OutputInfo } from "sharp";

import { LIMITS, TOO_TALL } from "@/core/intake/limits";

import { MAX_LONG_EDGE, type TilePlace, tileCount, tileSpans } from "@/core/shared/tileGeometry";

/**
 * Images as the model receives them (extraction spec, "Images sent to the model"):
 * each image cut into tiles that fit (tileGeometry.ts), encoded losslessly,
 * with each tile's place in its image kept so a contact box can be mapped
 * back to the screenshot the owner sees.
 */

/** The API's request limit, which the whole request must stay under. */
export const REQUEST_LIMIT_BYTES = 30_000_000;

/** Room kept for the rest of a request: the system prompt, the schema, the markers and the JSON around it all. */
export const REQUEST_OVERHEAD_BYTES = 1_000_000;

/** More image blocks than this in one request lower every image's size limit. */
export const MAX_IMAGE_BLOCKS = 20;

export const TOO_MUCH_IMAGE_DATA = "Too much image data for one job";
export const UNREADABLE = "A screenshot could not be read as an image.";
export const TOO_WIDE =
  "A screenshot is wider than 2,576 pixels. Add it again from the New job page, which narrows it.";

/** A tile ready to send, neutral about how a stage labels it. */
export interface Tile extends TilePlace {
  png: Uint8Array;
}

export type CutResult = { ok: true; tiles: Tile[] } | { ok: false; reason: string };

export type RequestCheck = { ok: true } | { ok: false; reason: typeof TOO_MUCH_IMAGE_DATA };

/**
 * Cuts each image into its tiles, in order, encoded as PNG so text never goes
 * through a second lossy pass. Each image is turned upright first, as the
 * owner saw it, so boxes refer to the upright image; address_read must crop
 * the upright image too. Sizes come first, from each image's header, so
 * nothing is decoded for a job that cannot be sent; then each image is
 * decoded once and cut from its pixels. An image that cannot be read, one too
 * wide, or more tiles than a request can carry come back as a reason.
 */
export async function cutTiles(images: readonly Uint8Array[]): Promise<CutResult> {
  let total = 0;
  for (const bytes of images) {
    const size = await uprightSize(bytes);
    if (size === null) return { ok: false, reason: UNREADABLE };
    if (size.width > MAX_LONG_EDGE) return { ok: false, reason: TOO_WIDE };
    if (size.height > LIMITS.height) return { ok: false, reason: TOO_TALL };
    total += tileCount(size.width, size.height);
  }
  if (total > MAX_IMAGE_BLOCKS) return { ok: false, reason: TOO_MUCH_IMAGE_DATA };

  const tiles: Tile[] = [];
  for (const [image, bytes] of images.entries()) {
    let decoded: { data: Buffer; info: OutputInfo };
    try {
      decoded = await sharp(bytes).autoOrient().raw().toBuffer({ resolveWithObject: true });
    } catch {
      return { ok: false, reason: UNREADABLE };
    }
    const { width, height, channels } = decoded.info;
    if (width > MAX_LONG_EDGE) return { ok: false, reason: TOO_WIDE };
    for (const span of tileSpans(width, height)) {
      const png = await sharp(decoded.data, { raw: { width, height, channels } })
        .extract({ left: 0, top: span.top, width, height: span.height })
        .png()
        .toBuffer();
      tiles.push({ image, top: span.top, width, height: span.height, png: new Uint8Array(png) });
    }
  }
  return { ok: true, tiles };
}

/** An image's size once turned upright, from its header alone, or null when it cannot be read. */
export async function uprightSize(
  bytes: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    return null;
  }
  const { width, height, orientation } = metadata;
  if (!width || !height) return null;
  // EXIF orientations 5 to 8 turn the image a quarter turn, swapping its sides.
  return orientation !== undefined && orientation >= 5
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Whether one request can carry these tiles and this text: at most 20 image
 * blocks, and under 30 MB with each image counted as the base64 the API
 * receives, the text as UTF-8, and room kept for the rest of the request.
 */
export function checkRequest(tiles: readonly Tile[], text: string): RequestCheck {
  if (tiles.length > MAX_IMAGE_BLOCKS) return { ok: false, reason: TOO_MUCH_IMAGE_DATA };
  const imageBytes = tiles.reduce((sum, tile) => sum + 4 * Math.ceil(tile.png.length / 3), 0);
  const textBytes = new TextEncoder().encode(text).length;
  return imageBytes + textBytes + REQUEST_OVERHEAD_BYTES < REQUEST_LIMIT_BYTES
    ? { ok: true }
    : { ok: false, reason: TOO_MUCH_IMAGE_DATA };
}
