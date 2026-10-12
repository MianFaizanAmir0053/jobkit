import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { CROP, cropContact, cropRect } from "./crop";

/* The contact crop the second read sees: extraction AC9. */

async function blankPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer(),
  );
}

describe("cropRect", () => {
  it("adds the 40-pixel margin around the box", () => {
    expect(cropRect({ x1: 500, y1: 500, x2: 800, y2: 560 }, { width: 1000, height: 2000 })).toEqual(
      { left: 460, top: 460, width: 380, height: 140 },
    );
  });

  it("grows a narrow box about its centre to at least 240 pixels wide", () => {
    // The margins alone make it 85 high, above the 64-pixel minimum.
    expect(cropRect({ x1: 500, y1: 500, x2: 520, y2: 505 }, { width: 1000, height: 2000 })).toEqual(
      { left: 390, top: 460, width: 240, height: 85 },
    );
  });

  it("moves a crop that runs off an edge back inside the image, keeping its size", () => {
    expect(cropRect({ x1: 0, y1: 0, x2: 50, y2: 20 }, { width: 1000, height: 2000 })).toEqual({
      left: 0,
      top: 0,
      width: 240,
      height: 100,
    });
    expect(
      cropRect({ x1: 950, y1: 1980, x2: 1000, y2: 2000 }, { width: 1000, height: 2000 }),
    ).toEqual({ left: 760, top: 1900, width: 240, height: 100 });
  });

  it("is the whole image when the image is smaller than the minimum", () => {
    expect(cropRect({ x1: 10, y1: 10, x2: 20, y2: 20 }, { width: 200, height: 50 })).toEqual({
      left: 0,
      top: 0,
      width: 200,
      height: 50,
    });
  });

  it("refuses a box that is empty or outside the image", () => {
    const image = { width: 1000, height: 2000 };
    expect(cropRect({ x1: 10, y1: 10, x2: 10, y2: 30 }, image)).toBeNull();
    expect(cropRect({ x1: 900, y1: 10, x2: 1100, y2: 30 }, image)).toBeNull();
    expect(cropRect({ x1: -5, y1: 10, x2: 30, y2: 30 }, image)).toBeNull();
  });
});

describe("cropContact", () => {
  it("cuts the crop from the image and enlarges it twofold, as PNG", async () => {
    const png = await blankPng(1000, 2000);

    const crop = await cropContact(png, { image: 0, x1: 500, y1: 500, x2: 800, y2: 560 });

    expect(crop).not.toBeNull();
    const meta = await sharp(crop!).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([380 * CROP.scale, 140 * CROP.scale]);
  });

  it("crops the upright image, as the owner saw it and the box was read", async () => {
    // Stored 2000 wide and 1000 high, marked to be turned a quarter: upright it is 1000 by 2000.
    const sideways = new Uint8Array(
      await sharp({
        create: { width: 2000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );

    const crop = await cropContact(sideways, { image: 0, x1: 500, y1: 1500, x2: 800, y2: 1560 });

    const meta = await sharp(crop!).metadata();
    expect([meta.width, meta.height]).toEqual([380 * CROP.scale, 140 * CROP.scale]);
  });

  it("is null for bytes that are not an image, or a box outside it", async () => {
    expect(
      await cropContact(new Uint8Array([1, 2, 3]), { image: 0, x1: 0, y1: 0, x2: 10, y2: 10 }),
    ).toBeNull();
    expect(
      await cropContact(await blankPng(100, 100), { image: 0, x1: 50, y1: 50, x2: 150, y2: 60 }),
    ).toBeNull();
  });
});
