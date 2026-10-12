import sharp from "sharp";

/**
 * Images as Claude receives them (extraction spec, "Images sent to Claude").
 * Claude's high-resolution models take at most 2,576 pixels on the long edge
 * and 4,784 visual tokens per image, and silently shrink a larger image, after
 * which the coordinates they return refer to the shrunken copy. So code cuts
 * every image to fit, losslessly, and keeps each tile's place in its image so
 * a contact box can be mapped back to the screenshot the owner sees.
 */

export const MAX_LONG_EDGE = 2576;
export const MAX_VISUAL_TOKENS = 4784;

/** Each visual token covers a square this many pixels wide. */
const TOKEN_EDGE = 28;

/** Rows two neighbouring tiles share, so a line cut by one edge is whole in the other tile. */
export const TILE_OVERLAP = 200;

/** One request's ceiling, in bytes as sent, kept under the API's own request limit. */
export const REQUEST_LIMIT_BYTES = 30_000_000;

/** More image blocks than this in one request lower every image's size limit. */
export const MAX_IMAGE_BLOCKS = 20;

export const TOO_MUCH_IMAGE_DATA = "Too much image data for one job";

/** Intake's own message for the same limit (intake spec, "Limits"). */
export const TOO_MANY_TILES =
  "Too many screenshots for one job. Remove some, or split the post into two jobs.";

/** A horizontal strip of one image, at the image's full width. */
export interface TileSpan {
  top: number;
  height: number;
}

/** A tile ready to send, neutral about how a stage labels it. */
export interface Tile {
  /** The image's position among the images cut, from 0. */
  image: number;
  /** The tile's first row in its image. */
  top: number;
  width: number;
  height: number;
  png: Uint8Array;
}

/** A box as a model reports it: the tile's number from 1, in the order sent, and corners in its pixels. */
export interface TileBox {
  tile: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The same box in its image's pixels. */
export interface ImageBox {
  image: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type RequestCheck =
  | { ok: true }
  | { ok: false; reason: typeof TOO_MUCH_IMAGE_DATA | typeof TOO_MANY_TILES };

/** What an image of this size costs: one token per 28-pixel square, each side rounded up. */
export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / TOKEN_EDGE) * Math.ceil(height / TOKEN_EDGE);
}

/** The tallest tile an image of this width can be cut into within both limits. */
export function tileHeight(width: number): number {
  return Math.min(MAX_LONG_EDGE, TOKEN_EDGE * Math.floor(MAX_VISUAL_TOKENS / Math.ceil(width / TOKEN_EDGE)));
}

/**
 * Where to cut an image: whole when it fits in one tile, otherwise strips of
 * the tile height overlapping by 200 rows, the last one shorter. Intake scales
 * anything wider than 2,576 pixels down, so a wider image here is a bug.
 */
export function tileSpans(width: number, height: number): TileSpan[] {
  if (!(width >= 1 && height >= 1)) throw new Error(`An image of size ${width} × ${height} has no pixels.`);
  if (width > MAX_LONG_EDGE) throw new Error(`An image ${width} pixels wide is wider than ${MAX_LONG_EDGE}.`);
  const tall = tileHeight(width);
  const spans: TileSpan[] = [];
  for (let top = 0; ; top += tall - TILE_OVERLAP) {
    const bottom = Math.min(top + tall, height);
    spans.push({ top, height: bottom - top });
    if (bottom === height) return spans;
  }
}

/**
 * Cuts each image into its tiles, in order, encoded as PNG so text never goes
 * through a second lossy pass. Each image is turned upright first, as the
 * owner saw it, so boxes refer to the upright image; address_read must crop
 * the upright image too. Each image is decoded once and cut from its pixels.
 */
export async function cutTiles(images: readonly Uint8Array[]): Promise<Tile[]> {
  const tiles: Tile[] = [];
  for (const [image, bytes] of images.entries()) {
    const { data, info } = await sharp(bytes).autoOrient().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    for (const span of tileSpans(width, height)) {
      const png = await sharp(data, { raw: { width, height, channels } })
        .extract({ left: 0, top: span.top, width, height: span.height })
        .png()
        .toBuffer();
      tiles.push({ image, top: span.top, width, height: span.height, png: new Uint8Array(png) });
    }
  }
  return tiles;
}

/**
 * Whether one request can carry these tiles and this text: at most 20 image
 * blocks, and at most 30 MB with each image counted as the base64 the API
 * receives and the text as UTF-8.
 */
export function checkRequest(tiles: readonly Tile[], text: string): RequestCheck {
  if (tiles.length > MAX_IMAGE_BLOCKS) return { ok: false, reason: TOO_MANY_TILES };
  const imageBytes = tiles.reduce((sum, tile) => sum + 4 * Math.ceil(tile.png.length / 3), 0);
  const textBytes = new TextEncoder().encode(text).length;
  return imageBytes + textBytes <= REQUEST_LIMIT_BYTES
    ? { ok: true }
    : { ok: false, reason: TOO_MUCH_IMAGE_DATA };
}

/**
 * A box a model reported for a tile, in its image's pixels: the tile's offset
 * added to both rows. None when the tile does not exist or the box is not a
 * non-empty box inside it; the record's checks flag that.
 */
export function mapBox(box: TileBox, tiles: readonly Tile[]): ImageBox | null {
  const tile = Number.isInteger(box.tile) ? tiles[box.tile - 1] : undefined;
  if (tile === undefined) return null;
  const { x1, y1, x2, y2 } = box;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x1 < 0 || y1 < 0 || x2 > tile.width || y2 > tile.height || x1 >= x2 || y1 >= y2) return null;
  return { image: tile.image, x1, y1: y1 + tile.top, x2, y2: y2 + tile.top };
}
