import type { Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

/**
 * The post's crop and screenshots as the job page shows them (review spec,
 * "Contact panel"): only through signed read URLs that last 60 seconds, so
 * no image is ever public or lasting. The crop of the contact the second
 * read looked at stands beside it; the screenshots, in their order, show
 * when the owner must type the contact from them, as when the reads
 * disagree or no crop exists. An image storage cannot sign, as one a purge
 * removed, is left out rather than failing the page.
 */

export const IMAGE_URL_SECONDS = 60;

export interface PostImages {
  /** The crop's URL; null when there is none to show. */
  crop: string | null;
  /** The post's screenshots' URLs, in their order; none unless asked for. */
  screenshots: string[];
}

export async function postImages(
  deps: { db: Db; storage: Storage },
  jobId: string,
  wanted: { cropPath: string | null; screenshots: boolean },
): Promise<PostImages> {
  if (!isUuid(jobId)) return { crop: null, screenshots: [] };
  const signed = (path: string) =>
    deps.storage.createSignedReadUrl(path, IMAGE_URL_SECONDS).catch(() => null);
  const crop = wanted.cropPath ? await signed(wanted.cropPath) : null;
  if (!wanted.screenshots) return { crop, screenshots: [] };
  const { rows } = await deps.db.query<{ storage_path: string }>(
    `select storage_path from {{schema}}.job_images
      where job_id = $1 and purpose = 'post' order by position`,
    [jobId],
  );
  const screenshots: string[] = [];
  for (const row of rows) {
    const url = await signed(row.storage_path);
    if (url) screenshots.push(url);
  }
  return { crop, screenshots };
}
