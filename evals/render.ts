import { readFileSync } from "node:fs";

import type { Browser } from "@playwright/test";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The synthetic posts as phone screenshots (evals spec, "Case sources"):
 * each post's text laid out as a feed post, rendered by Chrome at 360 CSS
 * pixels wide and three device pixels to each, so a 1080-pixel-wide image
 * of the height the post asks for. Everything is inline and offline, so a
 * post renders to the same bytes on every run on one machine.
 */

const postSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  render: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
});

export type SyntheticPost = z.infer<typeof postSchema>;

/** CSS pixels across a phone's screen. */
const PHONE_WIDTH = 360;

export function loadSyntheticPosts(file: string): SyntheticPost[] {
  return z.array(postSchema).parse(parse(readFileSync(file, "utf8")));
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

/** The post as a PNG of exactly its render size. */
export async function renderPost(browser: Browser, post: SyntheticPost): Promise<Buffer> {
  const scale = post.render.width / PHONE_WIDTH;
  const page = await browser.newPage({
    viewport: { width: PHONE_WIDTH, height: Math.round(post.render.height / scale) },
    deviceScaleFactor: scale,
  });
  try {
    await page.setContent(postHtml(post), { waitUntil: "load" });
    return await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
  } finally {
    await page.close();
  }
}
