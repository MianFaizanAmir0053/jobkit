/**
 * The geometry of tiles (extraction spec, "Images sent to the model"). Claude's
 * high-resolution models take at most 2,576 pixels on the long edge and 4,784
 * visual tokens per image, and silently shrink a larger image, after which the
 * coordinates they return refer to the shrunken copy; so images are cut into
 * tiles that fit, and a box a model reports in a tile is mapped back to its
 * image. This module imports nothing and is shared: intake's browser code
 * counts tiles with the formula the server cuts them by, and the record's
 * checks map boxes without loading sharp, which only extraction's tiles.ts
 * does.
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

/** Where a tile sits: its image's position among the images cut, from 0, its first row, and its size. */
export interface TilePlace {
  image: number;
  top: number;
  width: number;
  height: number;
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

/** What an image of this size costs: one token per 28-pixel square, each side rounded up. */
export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / TOKEN_EDGE) * Math.ceil(height / TOKEN_EDGE);
}

/** The tallest tile an image of this width can be cut into within both limits. */
export function tileHeight(width: number): number {
  return Math.min(
    MAX_LONG_EDGE,
    TOKEN_EDGE * Math.floor(MAX_VISUAL_TOKENS / Math.ceil(width / TOKEN_EDGE)),
  );
}

/** Whether an image of this size can be cut: whole pixels, and no wider than 2,576. */
function cuttable(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= MAX_LONG_EDGE
  );
}

/**
 * Where to cut an image: whole when it fits in one tile, otherwise strips of
 * the tile height overlapping by 200 rows, the last one shorter. Intake
 * scales anything wider than 2,576 pixels down, and decoders give whole
 * pixels, so any other size here is a bug.
 */
export function tileSpans(width: number, height: number): TileSpan[] {
  if (!cuttable(width, height)) {
    throw new Error(`An image of ${width} × ${height} pixels cannot be cut into tiles.`);
  }
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
 * size comes from the client: a size that cannot be cut counts as more tiles
 * than any request can carry, so the tile limit refuses it rather than a throw.
 */
export function tileCount(width: number, height: number): number {
  if (!cuttable(width, height)) return Number.POSITIVE_INFINITY;
  const tall = tileHeight(width);
  return height <= tall ? 1 : 1 + Math.ceil((height - tall) / (tall - TILE_OVERLAP));
}

/**
 * A box a model reported for a tile, in its image's pixels: the tile's offset
 * added to both rows. None when the tile does not exist or the box is not a
 * non-empty box inside it; the record's checks flag that.
 */
export function mapBox(box: TileBox, tiles: readonly TilePlace[]): ImageBox | null {
  const tile = Number.isInteger(box.tile) ? tiles[box.tile - 1] : undefined;
  if (tile === undefined) return null;
  const { x1, y1, x2, y2 } = box;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x1 < 0 || y1 < 0 || x2 > tile.width || y2 > tile.height || x1 >= x2 || y1 >= y2) return null;
  return { image: tile.image, x1, y1: y1 + tile.top, x2, y2: y2 + tile.top };
}
