import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  checkRequest,
  cutTiles,
  MAX_IMAGE_BLOCKS,
  REQUEST_LIMIT_BYTES,
  REQUEST_OVERHEAD_BYTES,
  type Tile,
  TOO_MUCH_IMAGE_DATA,
  TOO_WIDE,
  UNREADABLE,
} from "./tiles";

/* Extraction AC1, apart from the oversized-image setting on each block (Task 16's). */

const WHITE = { r: 255, g: 255, b: 255 };
const RED = { r: 255, g: 0, b: 0 };

function blank(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: WHITE } });
}

async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await blank(width, height).png().toBuffer());
}

/** A white image with a red band across the given rows. */
async function banded(
  width: number,
  height: number,
  top: number,
  rows: number,
): Promise<Uint8Array> {
  const band = { create: { width, height: rows, channels: 3 as const, background: RED } };
  return new Uint8Array(
    await blank(width, height)
      .composite([{ input: band, top, left: 0 }])
      .png()
      .toBuffer(),
  );
}

async function pixel(image: Uint8Array, x: number, y: number): Promise<number[]> {
  const raw = await sharp(image).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return [...raw.subarray(0, 3)];
}

async function cut(images: Uint8Array[]): Promise<Tile[]> {
  const result = await cutTiles(images);
  if (!result.ok) throw new Error(result.reason);
  return result.tiles;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A tile whose PNG has `bytes` bytes, for the request-size checks. */
function sized(bytes: number): Tile {
  return { image: 0, top: 0, width: 1080, height: 2576, png: new Uint8Array(bytes) };
}

describe("cutTiles", () => {
  it("tiles each image in order, with its image index, offset and size", async () => {
    const tiles = await cut([await png(1080, 2400), await png(1080, 6000)]);
    expect(tiles.map(({ image, top, width, height }) => ({ image, top, width, height }))).toEqual([
      { image: 0, top: 0, width: 1080, height: 2400 },
      { image: 1, top: 0, width: 1080, height: 2576 },
      { image: 1, top: 2376, width: 1080, height: 2576 },
      { image: 1, top: 4752, width: 1080, height: 1248 },
    ]);
  });

  it("encodes every tile as PNG at its own size, even from a JPEG", async () => {
    const jpeg = new Uint8Array(await blank(1080, 3000).jpeg().toBuffer());
    const tiles = await cut([jpeg]);
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect([...tile.png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      const metadata = await sharp(tile.png).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual([
        "png",
        tile.width,
        tile.height,
      ]);
    }
  });

  it("cuts each tile from the rows it says it covers", async () => {
    const tiles = await cut([await banded(1080, 6000, 4800, 100)]);
    const [, second, third] = tiles as [Tile, Tile, Tile];
    expect(await pixel(third.png, 500, 4800 - third.top)).toEqual([255, 0, 0]);
    expect(await pixel(third.png, 500, 4800 - third.top - 1)).toEqual([255, 255, 255]);
    expect(await pixel(second.png, 500, 4899 - second.top)).toEqual([255, 0, 0]);
    expect(await pixel(second.png, 500, 4900 - second.top)).toEqual([255, 255, 255]);
  });

  it("turns an image upright first, as the owner saw it", async () => {
    const sideways = new Uint8Array(
      await blank(300, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    );
    const [tile] = await cut([sideways]);
    expect([tile!.width, tile!.height]).toEqual([100, 300]);
    const metadata = await sharp(tile!.png).metadata();
    expect([metadata.width, metadata.height]).toEqual([100, 300]);
  });

  it("sizes a tall screenshot stored sideways as the upright image it is", async () => {
    // 6,000 wide as stored, but a 1,080 × 6,000 screenshot once turned upright.
    const sideways = new Uint8Array(
      await blank(6000, 1080).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    );

    const tiles = await cut([sideways]);

    expect(tiles.map(({ width, height }) => [width, height])).toEqual([
      [1080, 2576],
      [1080, 2576],
      [1080, 1248],
    ]);
  });

  it("returns no tiles for no images", async () => {
    expect(await cutTiles([])).toEqual({ ok: true, tiles: [] });
  });

  it("gives a reason, not an error, for bytes that are no image", async () => {
    const notAnImage = new TextEncoder().encode("this is not a picture");

    expect(await cutTiles([await png(10, 10), notAnImage])).toEqual({
      ok: false,
      reason: UNREADABLE,
    });
  });

  it("gives a reason for an image wider than 2,576 pixels once upright, which intake narrows first", async () => {
    // 100 wide as stored, 3,000 wide upright.
    const turned = new Uint8Array(
      await blank(100, 3000).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    );

    expect(await cutTiles([await png(3000, 100)])).toEqual({ ok: false, reason: TOO_WIDE });
    expect(await cutTiles([turned])).toEqual({ ok: false, reason: TOO_WIDE });
  });

  it("refuses more tiles than one request carries, before cutting any", async () => {
    const screenshot = await png(1080, 2400);
    const images = Array.from({ length: MAX_IMAGE_BLOCKS + 1 }, () => screenshot);

    expect(await cutTiles(images)).toEqual({ ok: false, reason: TOO_MUCH_IMAGE_DATA });
  });
});

describe("checkRequest", () => {
  // What a request can spend on images (as base64) and text, keeping room for the rest of it.
  const budget = REQUEST_LIMIT_BYTES - REQUEST_OVERHEAD_BYTES;
  // A PNG whose base64 is 4 bytes short of the budget.
  const nearlyFull = (budget / 4) * 3 - 3;

  it("accepts a request under 30 MB, counting images as the base64 the API receives", () => {
    expect(checkRequest([sized(nearlyFull)], "")).toEqual({ ok: true });
  });

  it("counts the pasted text in UTF-8 bytes, and refuses what reaches the limit", () => {
    expect(checkRequest([sized(nearlyFull)], "abc")).toEqual({ ok: true });
    expect(checkRequest([sized(nearlyFull)], "abcd")).toEqual({
      ok: false,
      reason: TOO_MUCH_IMAGE_DATA,
    });
    // An Arabic-Indic digit is two bytes in UTF-8.
    expect(checkRequest([sized(nearlyFull)], "a٠٠")).toEqual({
      ok: false,
      reason: TOO_MUCH_IMAGE_DATA,
    });
  });

  it("refuses more than 20 image blocks, which would lower each image's limit", () => {
    const tiles = Array.from({ length: MAX_IMAGE_BLOCKS }, () => sized(10));
    expect(checkRequest(tiles, "")).toEqual({ ok: true });
    expect(checkRequest([...tiles, sized(10)], "")).toEqual({
      ok: false,
      reason: TOO_MUCH_IMAGE_DATA,
    });
  });

  it("uses the message the owner sees", () => {
    expect(TOO_MUCH_IMAGE_DATA).toBe("Too much image data for one job");
  });
});
