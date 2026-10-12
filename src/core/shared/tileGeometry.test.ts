import { describe, expect, it } from "vitest";

import {
  MAX_LONG_EDGE,
  MAX_VISUAL_TOKENS,
  mapBox,
  type TilePlace,
  tileCount,
  tileHeight,
  tileSpans,
  visualTokens,
} from "@/core/shared/tileGeometry";

/* Extraction AC1's geometry: tile heights, cuts and boxes mapped back. */

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

  it("refuses a size it cannot cut: wider than 2,576, no pixels, part of a pixel, or no end", () => {
    for (const [width, height] of [
      [2577, 1000],
      [0, 1000],
      [1080, 0],
      [1080, 2600.5],
      [1080, Number.POSITIVE_INFINITY],
      [Number.NaN, 1000],
    ]) {
      expect(() => tileSpans(width!, height!), `${width} × ${height}`).toThrow(/cannot be cut/);
    }
  });
});

describe("tileCount", () => {
  it("counts the tiles tileSpans cuts, for any size it can cut", () => {
    for (const width of [1, 28, 720, 1080, 1170, 1440, 2000, 2576]) {
      for (const height of [1, 1455, 1456, 1457, 2576, 2577, 4952, 4953, 6000, 20000, 30000]) {
        expect(tileCount(width, height), `${width} × ${height}`).toBe(
          tileSpans(width, height).length,
        );
      }
    }
  });

  it("counts a size it cannot cut as more tiles than any request carries", () => {
    for (const [width, height] of [
      [2577, 1000],
      [0, 1000],
      [1080, 2600.5],
      [1080, Number.POSITIVE_INFINITY],
    ]) {
      expect(tileCount(width!, height!)).toBe(Number.POSITIVE_INFINITY);
    }
  });
});

describe("visualTokens", () => {
  it("counts 28-pixel squares, rounding each side up", () => {
    expect(visualTokens(1080, 2576)).toBe(39 * 92);
    expect(visualTokens(2576, 1456)).toBe(4784);
    expect(visualTokens(29, 1)).toBe(2);
  });
});

describe("mapBox", () => {
  // Places only: mapping a box needs no image bytes.
  const tiles: TilePlace[] = [
    { image: 0, top: 0, width: 1080, height: 2400 },
    { image: 1, top: 0, width: 1080, height: 2576 },
    { image: 1, top: 2376, width: 1080, height: 2576 },
    { image: 1, top: 4752, width: 1080, height: 1248 },
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
