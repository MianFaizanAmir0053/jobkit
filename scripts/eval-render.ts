/**
 *   npm run eval:render     every synthetic post to evals/synthetic/screenshots/<id>.png
 *
 * Renders the public synthetic posts as phone screenshots with the installed
 * Chrome (evals spec, "Case sources"), the same bytes on every run with the
 * same Chrome. Chrome updates itself, so manifest.json beside the images
 * records its version and each image's hash, and a run names any image
 * whose bytes changed since the last: evaluation runs on the old and the
 * new images are not comparable. Every post is rendered aside first, and
 * only a full set replaces the last one: a post that fails leaves the last
 * images and their manifest as they were. The images are made again
 * whenever they are needed, so git keeps only the posts.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  // Inside the screenshots folder, which git ignores.
  const aside = mkdtempSync(join(out, ".rendering-"));
  const images: Record<string, Buffer> = {};
  let version: string;
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    version = browser.version();
    try {
      for (const post of loadSyntheticPosts(join(synthetic, "posts.yaml"))) {
        const name = `${post.id}.png`;
        const png = await renderPost(browser, post);
        images[name] = png;
        writeFileSync(join(aside, name), png);
        console.log(`${name}  ${post.render.width} x ${post.render.height}`);
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    rmSync(aside, { recursive: true, force: true });
    throw error;
  }

  // The manifest goes first and comes back last, so a set cut short has none to vouch for it.
  rmSync(manifestFile, { force: true });
  for (const name of Object.keys(images)) renameSync(join(aside, name), join(out, name));
  for (const file of readdirSync(out)) {
    if (file.endsWith(".png") && !Object.hasOwn(images, file)) rmSync(join(out, file));
  }
  const manifest = manifestOf(version, images);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(aside, { recursive: true, force: true });

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
  }
  if (previous && changes.added.length > 0) console.log(`New: ${changes.added.join(", ")}`);
  if (changes.removed.length > 0) console.log(`Removed: ${changes.removed.join(", ")}`);
  if (previous && changes.changed.length + changes.added.length + changes.removed.length === 0) {
    console.log("Every image matches the last render.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
