/**
 *   npm run eval:render     every synthetic post to evals/synthetic/screenshots/<id>.png
 *
 * Renders the public synthetic posts as phone screenshots with the installed
 * Chrome (evals spec, "Case sources"), the same bytes on every run with the
 * same Chrome. Chrome updates itself, so manifest.json beside the images
 * records its version, each image's hash and the hash of the post it shows,
 * and a run names any image whose bytes or post changed since the last:
 * evaluation runs on the old and the new images are not comparable. Every
 * post is rendered aside first, and only a full set replaces the last one:
 * a post that fails leaves the last images and their manifest as they were.
 * The images are made again whenever they are needed, so git keeps only the
 * posts.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  readManifest,
  type RenderManifest,
  renderPost,
  sourceOf,
} from "../evals/render";

/** Writes a file whole: a crash leaves the old one, never half of the new. */
function writeWhole(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** The last run's manifest, or its copy kept while a run replaced the images; null when neither can be read. */
function previousManifest(manifestFile: string, lastFile: string): RenderManifest | null {
  for (const file of [manifestFile, lastFile]) {
    try {
      const manifest = readManifest(file);
      if (manifest) return manifest;
    } catch (error) {
      console.warn(
        `${error instanceof Error ? error.message : String(error)} Going on without it.`,
      );
    }
  }
  return null;
}

async function main(): Promise<void> {
  const synthetic = join(process.cwd(), "evals", "synthetic");
  const out = join(synthetic, "screenshots");
  const manifestFile = join(out, "manifest.json");
  const lastFile = join(out, "manifest.last.json");
  mkdirSync(out, { recursive: true });
  const previous = previousManifest(manifestFile, lastFile);
  // Inside the screenshots folder, which git ignores.
  const aside = mkdtempSync(join(out, ".rendering-"));
  const images: Record<string, { bytes: Buffer; source: string }> = {};
  let version: string;
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    version = browser.version();
    try {
      for (const post of loadSyntheticPosts(join(synthetic, "posts.yaml"))) {
        const name = `${post.id}.png`;
        const png = await renderPost(browser, post);
        images[name] = { bytes: png, source: sourceOf(post) };
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

  // The manifest goes first and comes back last, so a set cut short has none to vouch for it; a
  // copy of the last one waits until then, so the next run can still name what changed.
  if (previous) writeWhole(lastFile, `${JSON.stringify(previous, null, 2)}\n`);
  rmSync(manifestFile, { force: true });
  for (const name of Object.keys(images)) renameSync(join(aside, name), join(out, name));
  for (const file of readdirSync(out)) {
    if (file.endsWith(".png") && !Object.hasOwn(images, file)) rmSync(join(out, file));
  }
  const manifest = manifestOf(version, images);
  writeWhole(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(lastFile, { force: true });
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
  if (changes.edited.length > 0) {
    console.log(
      `These posts were edited since the last render, so runs before and after are not comparable on them: ${changes.edited.join(", ")}`,
    );
  }
  if (previous && changes.added.length > 0) console.log(`New: ${changes.added.join(", ")}`);
  if (changes.removed.length > 0) console.log(`Removed: ${changes.removed.join(", ")}`);
  const differ =
    changes.changed.length + changes.added.length + changes.removed.length + changes.edited.length;
  if (previous && differ === 0) {
    console.log("Every image matches the last render.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
