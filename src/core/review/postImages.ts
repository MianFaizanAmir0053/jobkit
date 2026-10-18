import type { Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

/**
 * The post's crop and screenshots as the job page shows them (review spec,
 * "Contact panel"): only through signed read URLs that last 60 seconds, so
 * no image is ever public or lasting. The crop of the contact the second
 * read looked at stands beside it; only a crop of this job's is signed. The
 * screenshots, the one the contact was read on first, show when the owner
 * must type the contact from them, and whenever there is no crop to show:
 * none was made, or storage cannot sign it, as one a purge removed. An
 * image storage cannot sign is left out rather than failing the page.
 */

export const IMAGE_URL_SECONDS = 60;

export interface PostScreenshot {
  /** The image's row: the same each time the page is drawn, though its URL is new. */
  id: string;
  url: string;
  /** Its place among the post's screenshots, from 0. */
  position: number;
  width: number;
  height: number;
}

export interface PostImages {
  /** The crop's URL; null when there is none to show. */
  crop: string | null;
  /** The post's screenshots, the one the contact was read on first; none while the crop shows, unless asked for. */
  screenshots: PostScreenshot[];
}

export async function postImages(
  deps: { db: Db; storage: Storage },
  jobId: string,
  wanted: { cropPath: string | null; screenshots: boolean; first?: number | null },
): Promise<PostImages> {
  if (!isUuid(jobId)) return { crop: null, screenshots: [] };
  const signed = (path: string) =>
    deps.storage.createSignedReadUrl(path, IMAGE_URL_SECONDS).catch(() => null);
  const ours = wanted.cropPath?.startsWith(`jobs/${jobId}/crops/`) ? wanted.cropPath : null;
  const crop = ours ? await signed(ours) : null;
  if (crop && !wanted.screenshots) return { crop, screenshots: [] };
  const { rows } = await deps.db.query<{
    id: string;
    storage_path: string;
    position: number;
    width: number;
    height: number;
  }>(
    `select id, storage_path, position, width, height from {{schema}}.job_images
      where job_id = $1 and purpose = 'post' order by position`,
    [jobId],
  );
  const first = wanted.first ?? null;
  const screenshots: PostScreenshot[] = [];
  for (const row of [
    ...rows.filter((row) => row.position === first),
    ...rows.filter((row) => row.position !== first),
  ]) {
    const url = await signed(row.storage_path);
    if (url) {
      screenshots.push({
        id: row.id,
        url,
        position: row.position,
        width: row.width,
        height: row.height,
      });
    }
  }
  return { crop, screenshots };
}
