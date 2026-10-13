import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { Browser, Page } from "@playwright/test";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The synthetic posts as phone screenshots (evals spec, "Case sources"):
 * each post's text laid out as a feed post, rendered by Chrome at 360 CSS
 * pixels wide and three device pixels to each, so a 1080-pixel-wide image
 * of the height the post asks for; a post too long for that height is
 * refused, never cut off. Everything is inline and offline, so a post
 * renders to the same bytes on every run with the same Chrome. The
 * installed Chrome updates itself, so each run's manifest records its
 * version, each image's hash and the hash of the post it shows, and the
 * next run names what changed; an image whose post was edited since it was
 * rendered is vouched for by no manifest.
 */

/** CSS pixels across a phone's screen. */
const PHONE_WIDTH = 360;

const postSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    render: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  })
  .superRefine(({ id, render: { width, height } }, ctx) => {
    // A whole number of device pixels to each CSS pixel, and a height they divide: else the
    // page's height is rounded, and the image is drawn at another height than the post gives.
    if (width % PHONE_WIDTH !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["render", "width"],
        message: `${id}'s render width ${width} is not a multiple of ${PHONE_WIDTH}.`,
      });
    } else if (height % (width / PHONE_WIDTH) !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["render", "height"],
        message: `${id}'s render height ${height} is not a multiple of ${width / PHONE_WIDTH}.`,
      });
    }
  });

export type SyntheticPost = z.infer<typeof postSchema>;

export function loadSyntheticPosts(file: string): SyntheticPost[] {
  const parsed = z.array(postSchema).safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`);
  }
  return parsed.data;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A post as a feed card: a poster's name and the post's words, each paragraph in its own direction. */
export function postHtml(post: SyntheticPost): string {
  const paragraphs = post.text
    .trimEnd()
    .split("\n")
    .map((line) => `<p dir="auto">${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #f3f2ef; }
  body { font: 15px/1.45 Arial, "Segoe UI", sans-serif; color: #191919; }
  .card { background: #fff; margin: 8px 0; padding: 12px 16px; }
  .who { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: #7a8c99; }
  .name { font-weight: bold; }
  .meta { color: #666; font-size: 12px; }
  p { margin: 0 0 4px; overflow-wrap: anywhere; }
</style></head><body><div class="card">
  <div class="who"><div class="avatar"></div><div><div class="name">Job post</div><div class="meta">1d</div></div></div>
  ${paragraphs}
</div></body></html>`;
}

/** The post laid out on a phone-sized page, for `look` to look at. */
async function onPage<T>(
  browser: Browser,
  post: SyntheticPost,
  look: (page: Page) => Promise<T>,
): Promise<T> {
  const scale = post.render.width / PHONE_WIDTH;
  const page = await browser.newPage({
    viewport: { width: PHONE_WIDTH, height: Math.round(post.render.height / scale) },
    deviceScaleFactor: scale,
  });
  try {
    await page.setContent(postHtml(post), { waitUntil: "load" });
    return await look(page);
  } finally {
    await page.close();
  }
}

/** How far down the page the post's card reaches, in CSS pixels. */
function cardBottom(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.ceil(document.querySelector(".card")!.getBoundingClientRect().bottom),
  );
}

/** Where the post's line starting with `start` is drawn, in the screenshot's pixels; null with no such line. */
export function lineBox(
  browser: Browser,
  post: SyntheticPost,
  start: string,
): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const scale = post.render.width / PHONE_WIDTH;
  return onPage(browser, post, (page) =>
    page.evaluate(
      ([wanted, factor]) => {
        const line = [...document.querySelectorAll("p")].find((p) =>
          (p.textContent ?? "").startsWith(wanted),
        );
        if (!line) return null;
        const range = document.createRange();
        range.selectNodeContents(line);
        const box = range.getBoundingClientRect();
        return {
          left: box.left * factor,
          top: box.top * factor,
          right: box.right * factor,
          bottom: box.bottom * factor,
        };
      },
      [start, scale] as const,
    ),
  );
}

/** The post's height as laid out, in CSS pixels. */
export function postHeight(browser: Browser, post: SyntheticPost): Promise<number> {
  return onPage(browser, post, cardBottom);
}

/** The post as a PNG of exactly its render size; a post that would not fit is refused. */
export async function renderPost(browser: Browser, post: SyntheticPost): Promise<Buffer> {
  return onPage(browser, post, async (page) => {
    const height = await cardBottom(page);
    const room = page.viewportSize()!.height;
    if (height > room) {
      throw new Error(
        `${post.id} is taller than its render size: ${height} CSS pixels in ${room}. Shorten its text or raise its height.`,
      );
    }
    return page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
  });
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/**
 * What a post's image shows: the SHA-256 of its page and its render size,
 * so an edit to its text, or to the page around it, is a new source.
 */
export function sourceOf(post: SyntheticPost): string {
  return sha256(JSON.stringify([postHtml(post), post.render.width, post.render.height]));
}

/** What a render run made: the browser's version, and each image's SHA-256 and its post's source. */
export interface RenderManifest {
  browser: string;
  images: Record<string, string>;
  sources: Record<string, string>;
}

export const manifestSchema = z.object({
  browser: z.string(),
  images: z.record(z.string(), z.string()),
  sources: z.record(z.string(), z.string()),
});

const byName = <T>(entries: Record<string, T>) =>
  Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));

export function manifestOf(
  browser: string,
  renders: Readonly<Record<string, { bytes: Uint8Array; source: string }>>,
): RenderManifest {
  return {
    browser,
    images: Object.fromEntries(byName(renders).map(([name, { bytes }]) => [name, sha256(bytes)])),
    sources: Object.fromEntries(byName(renders).map(([name, { source }]) => [name, source])),
  };
}

/** The manifest a run left; null with none, and a stop naming the file when it cannot be read. */
export function readManifest(file: string): RenderManifest | null {
  if (!existsSync(file)) return null;
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`${file} cannot be read: run npm run eval:render again.`);
  }
}

/**
 * What differs from the last run's renders: images whose bytes changed, or
 * whose posts were edited, and the browser, if it changed.
 */
export function changedRenders(previous: RenderManifest | null, current: RenderManifest) {
  const before = previous?.images ?? {};
  const now = current.images;
  const sources = previous?.sources ?? {};
  const names = (images: Record<string, string>) => Object.keys(images).sort();
  return {
    browser:
      previous && previous.browser !== current.browser
        ? { from: previous.browser, to: current.browser }
        : null,
    changed: names(now).filter((name) => Object.hasOwn(before, name) && before[name] !== now[name]),
    added: names(now).filter((name) => !Object.hasOwn(before, name)),
    removed: names(before).filter((name) => !Object.hasOwn(now, name)),
    edited: names(now).filter(
      (name) => Object.hasOwn(sources, name) && sources[name] !== current.sources[name],
    ),
  };
}

/**
 * Why the manifest does not vouch for the images of these posts, as the
 * runner needs before it scores them: an image missing, one whose bytes are
 * not those rendered, or one rendered from a post since edited. None when
 * it vouches for all.
 */
export function checkRenders(
  posts: readonly SyntheticPost[],
  manifest: RenderManifest,
  imageOf: (name: string) => Uint8Array | null,
): string[] {
  const problems: string[] = [];
  for (const post of posts) {
    const name = `${post.id}.png`;
    const bytes = imageOf(name);
    if (!bytes || !Object.hasOwn(manifest.images, name)) {
      problems.push(`${name} has not been rendered: run npm run eval:render.`);
    } else if (manifest.sources[name] !== sourceOf(post)) {
      problems.push(`${name} shows its post as it was before an edit: run npm run eval:render.`);
    } else if (manifest.images[name] !== sha256(bytes)) {
      problems.push(`${name} is not the image the last render made: run npm run eval:render.`);
    }
  }
  return problems;
}
