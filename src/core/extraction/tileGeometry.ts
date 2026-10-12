/**
 * The geometry of tiles (extraction spec, "Images sent to Claude"). Claude's
 * high-resolution models take at most 2,576 pixels on the long edge and 4,784
 * visual tokens per image, and silently shrink a larger image, after which the
 * coordinates they return refer to the shrunken copy; so images are cut into
 * tiles that fit. This module imports nothing, so intake's browser code counts
 * tiles with the same formula the server cuts them with. Browser code imports
 * it, never tiles.ts, which loads sharp.
 */

export const MAX_LONG_EDGE = 2576;
export const MAX_VISUAL_TOKENS = 4784;

/** Each visual token covers a square this many pixels wide. */
const TOKEN_EDGE = 28;

/** Rows two neighbouring tiles share, so a line cut by one edge is whole in the other tile. */
export const TILE_OVERLAP = 200;

/** A horizontal strip of one image, at the image's full width. */
export interface TileSpan {
  top: number;
  height: number;
}

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
 * How many tiles an image of this size is cut into, without cutting it.
 * Intake counts with this on the phone and again on the server, where the
 * size comes from the client: a size with no pixels, or wider than 2,576
 * pixels (which the phone scales down first), counts as more tiles than any
 * request can carry, so the 20-tile limit refuses it rather than a throw.
 */
export function tileCount(width: number, height: number): number {
  if (!(width >= 1 && height >= 1 && width <= MAX_LONG_EDGE)) return Number.POSITIVE_INFINITY;
  const tall = tileHeight(width);
  return height <= tall ? 1 : 1 + Math.ceil((height - tall) / (tall - TILE_OVERLAP));
}
