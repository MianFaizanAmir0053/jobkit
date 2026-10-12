import { tileCount } from "@/core/shared/tileGeometry";

/**
 * Intake's limits (intake spec, "Limits"). This module imports nothing from
 * the server, so the New job page refuses a job with the same rules and
 * words before it sends anything, and the server checks again with them.
 */

export const LIMITS = {
  images: 8,
  imageBytes: 10 * 1024 * 1024,
  /** Pixels, of the image as uploaded: scaled to 2,576 wide when it was wider. */
  height: 30_000,
  tiles: 20,
  textLength: 20_000,
} as const;

export const TOO_TALL = "Too tall. Take two shorter screenshots instead.";

/**
 * A share can wait on the phone before it is sent, but not for days: past
 * this the start time it would give the job is not believed (intake spec,
 * "Clock").
 */
export const MAX_HELD_MS = 24 * 60 * 60 * 1000;

export const CONTENT_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;

export interface ImageMeta {
  contentType: (typeof CONTENT_TYPES)[number];
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

/** The message to show when a job breaks intake's limits, or null. Repeats are dropped before this. */
export function refusal(images: readonly ImageMeta[], pastedText: string): string | null {
  if (images.length === 0 && pastedText.trim() === "") {
    return "Nothing to start: choose screenshots of the post, or paste its text.";
  }
  if (images.length > LIMITS.images) {
    return `At most ${LIMITS.images} screenshots per job. Remove some, or split the post into two jobs.`;
  }
  if (images.some((image) => image.height > LIMITS.height)) return TOO_TALL;
  if (images.some((image) => image.bytes > LIMITS.imageBytes)) {
    return "A screenshot is larger than 10 MB. Take a smaller screenshot of that part.";
  }
  if (pastedText.length > LIMITS.textLength) {
    return "The pasted text is longer than 20,000 characters. Paste only the job post.";
  }
  const tiles = images.reduce((sum, image) => sum + tileCount(image.width, image.height), 0);
  if (tiles > LIMITS.tiles) {
    return "Too many screenshots for one job. Remove some, or split the post into two jobs.";
  }
  return null;
}
