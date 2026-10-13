/**
 *   npm run eval:render     every synthetic post to evals/synthetic/screenshots/<id>.png
 *
 * Renders the public synthetic posts as phone screenshots with the installed
 * Chrome (evals spec, "Case sources"), the same bytes on every run on one
 * machine. The images are made again whenever they are needed, so git keeps
 * only the posts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import { loadSyntheticPosts, renderPost } from "../evals/render";

async function main(): Promise<void> {
  const synthetic = join(process.cwd(), "evals", "synthetic");
  const out = join(synthetic, "screenshots");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const post of loadSyntheticPosts(join(synthetic, "posts.yaml"))) {
      writeFileSync(join(out, `${post.id}.png`), await renderPost(browser, post));
      console.log(`${post.id}.png  ${post.render.width} x ${post.render.height}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
