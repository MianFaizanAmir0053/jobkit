import type { Db, Storage } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

/**
 * The post's crop and screenshots as the job page shows them (review spec,
 * "Contact panel"): only through signed read URLs that last 60 seconds, so
 * no image is ever public or lasting. The crop of the contact the second
 * read looked at stands beside it; only a crop of this job's is signed. The
 * screenshots, the one the contact was read on first, show when the owner
 * must type the contact from them, and, until the kit has gone, whenever
 * there is no crop to show: none was made, or storage cannot sign it, as
 * one a purge removed. An image storage cannot sign, or takes longer than
 * SIGN_MS to, is left out rather than failing or holding up the page.
 */

export const IMAGE_URL_SECONDS = 60;

/** How long storage may take to sign one image's URL. */
export const SIGN_MS = 5_000;

/** Which of the post's images a kit's page shows (the job view decides). */
export interface ImagesWanted {
  /** The crop of the contact the second read made; null for none. */
  cropPath: string | null;
  /**
   * The screenshots: always, as when the owner types the contact from them;
   * only when there is no crop to show; or never, once the kit has gone.
   */
  screenshots: "always" | "without-crop" | "never";
  /** The place of the screenshot the contact's box lies on, shown first; null for none. */
  first?: number | null;
  /** How many of the post's screenshots the job still keeps: none once the purge took them. */
  left?: number;
}

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
  /** The post's screenshots, the one the contact was read on first; none unless wanted. */
  screenshots: PostScreenshot[];
}

export async function postImages(
  deps: { db: Db; storage: Storage; signMs?: number },
  jobId: string,
  wanted: ImagesWanted,
): Promise<PostImages> {
  if (!isUuid(jobId)) return { crop: null, screenshots: [] };
  const signMs = deps.signMs ?? SIGN_MS;
  const signed = (path: string) =>
    new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), signMs);
      deps.storage.createSignedReadUrl(path, IMAGE_URL_SECONDS).then(
        (url) => {
          clearTimeout(timer);
          resolve(url);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  // The job's own crops, whatever case the job's ID was given in.
  const folder = `jobs/${jobId.toLowerCase()}/crops/`;
  const ours = wanted.cropPath?.startsWith(folder) ? wanted.cropPath : null;
  const crop = ours ? await signed(ours) : null;
  if (wanted.screenshots === "never" || (crop && wanted.screenshots === "without-crop")) {
    return { crop, screenshots: [] };
  }
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
  const ordered = [
    ...rows.filter((row) => row.position === first),
    ...rows.filter((row) => row.position !== first),
  ];
  const urls = await Promise.all(ordered.map((row) => signed(row.storage_path)));
  return {
    crop,
    screenshots: ordered.flatMap((row, i) => {
      const url = urls[i];
      return url
        ? [{ id: row.id, url, position: row.position, width: row.width, height: row.height }]
        : [];
    }),
  };
}
