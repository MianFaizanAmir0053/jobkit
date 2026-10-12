import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_BLOCKS,
  MAX_LONG_EDGE,
  MAX_VISUAL_TOKENS,
  REQUEST_LIMIT_BYTES,
  TOO_MANY_TILES,
  TOO_MUCH_IMAGE_DATA,
  type Tile,
  checkRequest,
  cutTiles,
  mapBox,
  tileHeight,
  tileSpans,
  visualTokens,
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
async function banded(width: number, height: number, top: number, rows: number): Promise<Uint8Array> {
  const band = { create: { width, height: rows, channels: 3 as const, background: RED } };
  return new Uint8Array(await blank(width, height).composite([{ input: band, top, left: 0 }]).png().toBuffer());
}

async function pixel(image: Uint8Array, x: number, y: number): Promise<number[]> {
  const raw = await sharp(image).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return [...raw.subarray(0, 3)];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A tile of the given size whose PNG has `bytes` bytes, for the request-size checks. */
function sized(bytes: number, top = 0): Tile {
  return { image: 0, top, width: 1080, height: 2576, png: new Uint8Array(bytes) };
}

describe("tileHeight", () => {
  it("is 2,576 for a 1,080-pixel-wide phone screenshot", () => {
    expect(tileHeight(1080)).toBe(2576);
  });

  it("is 1,456 for a 2,576-pixel-wide image", () => {
    expect(tileHeight(2576)).toBe(1456);
  });
});

describe("tileSpans", () => {
  it("sends a 1,080 × 2,400 image whole", () => {
    expect(tileSpans(1080, 2400)).toEqual([{ top: 0, height: 2400 }]);
  });

  it("sends an image exactly one tile tall whole", () => {
    expect(tileSpans(1080, 2576)).toEqual([{ top: 0, height: 2576 }]);
  });

  it("cuts a 1,080 × 6,000 image into three tiles of at most 2,576 pixels, overlapping by 200", () => {
    expect(tileSpans(1080, 6000)).toEqual([
      { top: 0, height: 2576 },
      { top: 2376, height: 2576 },
      { top: 4752, height: 1248 },
    ]);
  });

  it("cuts a 2,576-pixel-wide image into 1,456-pixel tiles", () => {
    expect(tileSpans(2576, 3000)).toEqual([
      { top: 0, height: 1456 },
      { top: 1256, height: 1456 },
      { top: 2512, height: 488 },
    ]);
  });

  it("covers every row and overlaps each pair of neighbours by 200 pixels", () => {
    for (const [width, height] of [
      [1080, 4952],
      [1080, 4953],
      [1440, 20000],
      [2576, 30000],
    ] as const) {
      const spans = tileSpans(width, height);
      expect(spans[0]!.top).toBe(0);
      expect(spans.at(-1)!.top + spans.at(-1)!.height).toBe(height);
      for (const [previous, next] of spans.slice(0, -1).map((span, i) => [span, spans[i + 1]!])) {
        expect(previous.top + previous.height - next.top).toBe(200);
      }
    }
  });

  it("keeps every tile within 2,576 pixels and 4,784 visual tokens", () => {
    for (const width of [1, 27, 28, 29, 720, 1080, 1170, 1440, 2000, 2575, 2576]) {
      for (const span of tileSpans(width, 40000)) {
        expect(span.height).toBeLessThanOrEqual(MAX_LONG_EDGE);
        expect(visualTokens(width, span.height)).toBeLessThanOrEqual(MAX_VISUAL_TOKENS);
      }
    }
  });

  it("refuses an image wider than 2,576 pixels, which intake scales down first", () => {
    expect(() => tileSpans(2577, 1000)).toThrow(/wider/);
  });

  it("refuses an image with no pixels", () => {
    expect(() => tileSpans(0, 1000)).toThrow(/size/);
    expect(() => tileSpans(1080, 0)).toThrow(/size/);
  });
});

describe("visualTokens", () => {
  it("counts 28-pixel squares, rounding each side up", () => {
    expect(visualTokens(1080, 2576)).toBe(39 * 92);
    expect(visualTokens(2576, 1456)).toBe(4784);
    expect(visualTokens(29, 1)).toBe(2);
  });
});

describe("cutTiles", () => {
  it("tiles each image in order, with its image index, offset and size", async () => {
    const tiles = await cutTiles([await png(1080, 2400), await png(1080, 6000)]);
    expect(tiles.map(({ image, top, width, height }) => ({ image, top, width, height }))).toEqual([
      { image: 0, top: 0, width: 1080, height: 2400 },
      { image: 1, top: 0, width: 1080, height: 2576 },
      { image: 1, top: 2376, width: 1080, height: 2576 },
      { image: 1, top: 4752, width: 1080, height: 1248 },
    ]);
  });

  it("encodes every tile as PNG at its own size, even from a JPEG", async () => {
    const jpeg = new Uint8Array(await blank(1080, 3000).jpeg().toBuffer());
    const tiles = await cutTiles([jpeg]);
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect([...tile.png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      const metadata = await sharp(tile.png).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual(["png", tile.width, tile.height]);
    }
  });

  it("cuts each tile from the rows it says it covers", async () => {
    const tiles = await cutTiles([await banded(1080, 6000, 4800, 100)]);
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
    const [tile] = await cutTiles([sideways]);
    expect([tile!.width, tile!.height]).toEqual([100, 300]);
    const metadata = await sharp(tile!.png).metadata();
    expect([metadata.width, metadata.height]).toEqual([100, 300]);
  });

  it("returns no tiles for no images", async () => {
    expect(await cutTiles([])).toEqual([]);
  });
});

describe("checkRequest", () => {
  it("accepts a request at 30 MB, counting images as the base64 the API receives", () => {
    const base64Limit = (REQUEST_LIMIT_BYTES / 4) * 3;
    expect(checkRequest([sized(base64Limit)], "")).toEqual({ ok: true });
  });

  it("refuses a request over 30 MB", () => {
    const half = REQUEST_LIMIT_BYTES / 2;
    expect(checkRequest([sized(half), sized(half)], "")).toEqual({
      ok: false,
      reason: TOO_MUCH_IMAGE_DATA,
    });
  });

  it("counts the pasted text in UTF-8 bytes", () => {
    const base64Limit = (REQUEST_LIMIT_BYTES / 4) * 3;
    expect(checkRequest([sized(base64Limit - 3)], "")).toEqual({ ok: true });
    expect(checkRequest([sized(base64Limit - 3)], "ab")).toEqual({ ok: true });
    expect(checkRequest([sized(base64Limit - 3)], "ab٠٠")).toEqual({
      ok: false,
      reason: TOO_MUCH_IMAGE_DATA,
    });
  });

  it("refuses more than 20 image blocks, which would lower each image's limit", () => {
    const tiles = Array.from({ length: MAX_IMAGE_BLOCKS }, () => sized(10));
    expect(checkRequest(tiles, "")).toEqual({ ok: true });
    expect(checkRequest([...tiles, sized(10)], "")).toEqual({ ok: false, reason: TOO_MANY_TILES });
  });

  it("uses the messages the owner sees", () => {
    expect(TOO_MUCH_IMAGE_DATA).toBe("Too much image data for one job");
    expect(TOO_MANY_TILES).toBe(
      "Too many screenshots for one job. Remove some, or split the post into two jobs.",
    );
  });
});

describe("mapBox", () => {
  const tiles: Tile[] = [
    { image: 0, top: 0, width: 1080, height: 2400, png: new Uint8Array() },
    { image: 1, top: 0, width: 1080, height: 2576, png: new Uint8Array() },
    { image: 1, top: 2376, width: 1080, height: 2576, png: new Uint8Array() },
    { image: 1, top: 4752, width: 1080, height: 1248, png: new Uint8Array() },
  ];

  it("maps a box in a later tile back to its image by adding the tile's offset", () => {
    expect(mapBox({ tile: 4, x1: 80, y1: 1020, x2: 620, y2: 1080 }, tiles)).toEqual({
      image: 1,
      x1: 80,
      y1: 5772,
      x2: 620,
      y2: 5832,
    });
  });

  it("numbers tiles from 1, in the order they are sent", () => {
    expect(mapBox({ tile: 1, x1: 0, y1: 0, x2: 1080, y2: 2400 }, tiles)).toEqual({
      image: 0,
      x1: 0,
      y1: 0,
      x2: 1080,
      y2: 2400,
    });
  });

  it.each([
    ["no tile", { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 }],
    ["tile 0", { tile: 0, x1: 0, y1: 0, x2: 10, y2: 10 }],
    ["a tile past the last", { tile: 5, x1: 0, y1: 0, x2: 10, y2: 10 }],
    ["a fractional tile number", { tile: 1.5, x1: 0, y1: 0, x2: 10, y2: 10 }],
    ["a box past the tile's right edge", { tile: 4, x1: 900, y1: 0, x2: 1081, y2: 10 }],
    ["a box past the tile's bottom", { tile: 4, x1: 0, y1: 1200, x2: 10, y2: 1249 }],
    ["a negative corner", { tile: 4, x1: -5, y1: 0, x2: 10, y2: 10 }],
    ["an empty box", { tile: 4, x1: 10, y1: 10, x2: 10, y2: 20 }],
    ["corners swapped", { tile: 4, x1: 20, y1: 30, x2: 10, y2: 10 }],
    ["a coordinate that is not a number", { tile: 4, x1: Number.NaN, y1: 0, x2: 10, y2: 10 }],
  ])("returns nothing for %s", (_case, box) => {
    expect(mapBox(box, tiles)).toBeNull();
  });
});
