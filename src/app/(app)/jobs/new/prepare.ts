import { encodingFor, prepareSize } from "@/core/intake/encode";
import type { ImageMeta } from "@/core/intake/limits";
import { tileCount } from "@/core/shared/tileGeometry";

/**
 * The browser's half of preparing a screenshot (intake spec, "Upload path"):
 * decode it upright, scale it only if wider than 2,576 pixels, encode it,
 * and hash it. The decisions live in src/core/intake/encode.ts, where they
 * are tested; this only drives the canvas.
 */

export interface PreparedImage {
  blob: Blob;
  meta: ImageMeta;
  tiles: number;
}

export type Prepared = ({ ok: true } & PreparedImage) | { ok: false; message: string };

const NOT_AN_IMAGE = "One of the files is not an image this browser can read.";
const NOT_ENCODED =
  "This browser could not prepare one of the screenshots. Take two shorter screenshots instead.";
// Browsers offer hashing only to secure pages: https, or localhost on the laptop.
const NOT_SECURE =
  "This page cannot prepare screenshots over a plain http address. Open jobkit at its https address, or at localhost on the laptop.";

export async function prepareImage(file: File): Promise<Prepared> {
  if (!globalThis.crypto?.subtle) return { ok: false, message: NOT_SECURE };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, message: NOT_AN_IMAGE };
  }
  try {
    const size = prepareSize(bitmap.width, bitmap.height);
    if (!size.ok) return size;
    const { width, height } = size;
    const blob = await draw(bitmap, width, height, encodingFor(width, height)).catch(() => null);
    if (!blob) return { ok: false, message: NOT_ENCODED };
    // A browser that cannot encode WebP gives PNG instead, which intake also takes.
    const contentType =
      blob.type === "image/webp" || blob.type === "image/jpeg" ? blob.type : "image/png";
    const digest = await blob
      .arrayBuffer()
      .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
      .catch(() => null);
    if (!digest) return { ok: false, message: NOT_ENCODED };
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      ok: true,
      blob,
      meta: { contentType, bytes: blob.size, width, height, sha256 },
      tiles: tileCount(width, height),
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Draws the image on white, as a screenshot is: text drawn on transparent
 * pixels shows the same on the page's dark background as to the model.
 */
function paint(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  width: number,
  height: number,
) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
}

async function draw(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  encoding: { type: string; quality: number },
): Promise<Blob> {
  // A canvas larger than the browser allows has no context.
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas of this size.");
    paint(context, bitmap, width, height);
    return canvas.convertToBlob(encoding);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas of this size.");
  paint(context, bitmap, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))),
      encoding.type,
      encoding.quality,
    ),
  );
}
