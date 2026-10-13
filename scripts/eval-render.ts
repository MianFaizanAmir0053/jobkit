/**
 *   npm run eval:render     every synthetic post to evals/synthetic/screenshots/<id>.png
 *
 * Renders the public synthetic posts as phone screenshots with the installed
 * Chrome (evals spec, "Case sources"), the same bytes on every run with the
 * same Chrome. Chrome updates itself, so manifest.json beside the images
 * records its version and each image's hash, and a run names any image
 * whose bytes changed since the last: evaluation runs on the old and the
 * new images are not comparable. The images are made again whenever they
 * are needed, so git keeps only the posts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import {
  changedRenders,
  loadSyntheticPosts,
  manifestOf,
  manifestSchema,
  renderPost,
} from "../evals/render";

async function main(): Promise<void> {
  const synthetic = join(process.cwd(), "evals", "synthetic");
  const out = join(synthetic, "screenshots");
  const manifestFile = join(out, "manifest.json");
  mkdirSync(out, { recursive: true });
  const previous = existsSync(manifestFile)
    ? manifestSchema.parse(JSON.parse(readFileSync(manifestFile, "utf8")))
    : null;
  const browser = await chromium.launch({ channel: "chrome" });
  const version = browser.version();
  const images: Record<string, Buffer> = {};
  try {
    for (const post of loadSyntheticPosts(join(synthetic, "posts.yaml"))) {
      const name = `${post.id}.png`;
      const png = await renderPost(browser, post);
      images[name] = png;
      writeFileSync(join(out, name), png);
      console.log(`${name}  ${post.render.width} x ${post.render.height}`);
    }
  } finally {
    await browser.close();
  }
  const manifest = manifestOf(version, images);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const changes = changedRenders(previous, manifest);
  if (changes.browser) {
    console.log(
      `Chrome changed since the last render: ${changes.browser.from} to ${changes.browser.to}.`,
    );
  }
  if (changes.changed.length > 0) {
    console.log(
      `These images differ from the last render, so runs before and after are not comparable on them: ${changes.changed.join(", ")}`,
    );
  } else if (previous) {
    console.log("Every image matches the last render.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
