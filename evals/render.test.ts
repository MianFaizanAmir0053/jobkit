import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Browser, chromium } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord } from "@/core/extraction/record";
import { mapBox, tileSpans } from "@/core/shared/tileGeometry";

import {
  changedRenders,
  checkRenders,
  lineBox,
  loadSyntheticPosts,
  manifestOf,
  postHeight,
  postHtml,
  readManifest,
  renderPost,
  sourceOf,
  type SyntheticPost,
} from "./render";

/* The synthetic screenshots: evals AC7. */

const POSTS = join(process.cwd(), "evals", "synthetic", "posts.yaml");

describe("loadSyntheticPosts", () => {
  it("reads every synthetic post with the size it renders at", () => {
    const posts = loadSyntheticPosts(POSTS);

    expect(posts).toHaveLength(14);
    expect(posts[0]).toMatchObject({
      id: "S01-email-simple",
      render: { width: 1080, height: 2400 },
    });
    expect(new Set(posts.map((post) => post.id)).size).toBe(posts.length);
    // One tall, scrolling screenshot among them.
    expect(posts.some((post) => post.render.height > 2400)).toBe(true);
  });

  it("refuses a render size a phone's pixels do not divide, which would draw another height", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobkit-posts-"));
    try {
      const file = join(dir, "posts.yaml");
      writeFileSync(file, "- id: X\n  text: A post.\n  render: { width: 1080, height: 2401 }\n");
      expect(() => loadSyntheticPosts(file)).toThrow(/2401/);
      writeFileSync(file, "- id: X\n  text: A post.\n  render: { width: 1000, height: 2400 }\n");
      expect(() => loadSyntheticPosts(file)).toThrow(/1000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("postHtml", () => {
  it("shows the post's words as text, never as markup, each paragraph in its own direction", () => {
    const html = postHtml({
      id: "X",
      text: "Line <b>one</b> & more\nسلام",
      render: { width: 1080, height: 2400 },
    });

    expect(html).toContain("Line &lt;b&gt;one&lt;/b&gt; &amp; more");
    expect(html).not.toContain("<b>");
    expect(html.match(/dir="auto"/g)).toHaveLength(2);
  });
});

const post = (id: string, text: string): SyntheticPost => ({
  id,
  text,
  render: { width: 1080, height: 2400 },
});

const render = (bytes: string, of: SyntheticPost) => ({
  bytes: Buffer.from(bytes),
  source: sourceOf(of),
});

describe("the render manifest", () => {
  it("names the renders whose bytes or posts changed since the last run, and the browser that changed", () => {
    const before = manifestOf("141.0.7390.55", {
      "S01.png": render("one", post("S01", "One.")),
      "S02.png": render("two", post("S02", "Two.")),
      "S03.png": render("three", post("S03", "Three.")),
      "S05.png": render("five", post("S05", "Five.")),
    });
    const after = manifestOf("142.0.7444.10", {
      "S01.png": render("one", post("S01", "One.")),
      "S02.png": render("two, now drawn otherwise", post("S02", "Two.")),
      "S04.png": render("four", post("S04", "Four.")),
      "S05.png": render("five", post("S05", "Five, edited.")),
    });

    expect(before.images["S01.png"]).toMatch(/^[0-9a-f]{64}$/);
    expect(before.sources["S01.png"]).toMatch(/^[0-9a-f]{64}$/);
    expect(changedRenders(before, after)).toEqual({
      browser: { from: "141.0.7390.55", to: "142.0.7444.10" },
      changed: ["S02.png"],
      added: ["S04.png"],
      removed: ["S03.png"],
      edited: ["S05.png"],
    });
    expect(changedRenders(after, after)).toEqual({
      browser: null,
      changed: [],
      added: [],
      removed: [],
      edited: [],
    });
    expect(changedRenders(null, after)).toMatchObject({
      browser: null,
      added: ["S01.png", "S02.png", "S04.png", "S05.png"],
    });
  });

  it("vouches only for images it holds, the same bytes, of posts as they read now", () => {
    const one = post("S01", "One.");
    const two = post("S02", "Two.");
    const manifest = manifestOf("142.0.7444.10", {
      "S01.png": render("one", one),
      "S02.png": render("two", two),
    });
    const images: Record<string, Buffer> = {
      "S01.png": Buffer.from("one"),
      "S02.png": Buffer.from("two"),
    };
    const imageOf = (name: string) => images[name] ?? null;

    expect(checkRenders([one, two], manifest, imageOf)).toEqual([]);
    // Its text edited, and not rendered again: the image shows words the post no longer has.
    expect(checkRenders([post("S01", "One, edited."), two], manifest, imageOf)).toEqual([
      expect.stringMatching(/S01\.png.*eval:render/),
    ]);
    images["S02.png"] = Buffer.from("two, drawn again by hand");
    expect(checkRenders([one, two], manifest, imageOf)).toEqual([
      expect.stringMatching(/S02\.png/),
    ]);
    expect(checkRenders([one, two, post("S03", "Three.")], manifest, imageOf)).toContainEqual(
      expect.stringMatching(/S03\.png/),
    );
  });

  it("reads a manifest, or none, and stops at one it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobkit-manifest-"));
    try {
      const file = join(dir, "manifest.json");
      expect(readManifest(file)).toBeNull();
      writeFileSync(file, "{ half");
      expect(() => readManifest(file)).toThrow(/manifest\.json/);
      const manifest = manifestOf("142.0.7444.10", {
        "S01.png": render("one", post("S01", "One.")),
      });
      writeFileSync(file, JSON.stringify(manifest));
      expect(readManifest(file)).toEqual(manifest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderPost", () => {
  let browser: Browser | null = null;

  beforeAll(async () => {
    // The installed Chrome, as the end-to-end tests use; without one, the renders are skipped.
    browser = await chromium.launch({ channel: "chrome" }).catch(() => null);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("renders a post at its size, the same bytes every time", async (ctx) => {
    if (!browser) return ctx.skip();
    const post = loadSyntheticPosts(POSTS)[0]!;

    const first = await renderPost(browser, post);
    const second = await renderPost(browser, post);

    const size = await sharp(first).metadata();
    expect([size.format, size.width, size.height]).toEqual(["png", 1080, 2400]);
    expect(Buffer.compare(first, second)).toBe(0);
  });

  // Three posts that lay out differently (the first, right-to-left Urdu, the tall one): every
  // post in a second browser would load the whole suite's run enough to time other tests out.
  // eval:render's manifest checks every post across runs.
  it("renders posts to the same bytes in a second launch of the browser", async (ctx) => {
    if (!browser) return ctx.skip();
    const posts = loadSyntheticPosts(POSTS).filter((post) =>
      ["S01-email-simple", "S08-urdu", "S12-tall-dubai"].includes(post.id),
    );
    expect(posts).toHaveLength(3);
    const again = await chromium.launch({ channel: "chrome" });
    try {
      for (const post of posts) {
        const first = await renderPost(browser, post);
        expect(Buffer.compare(first, await renderPost(again, post)), post.id).toBe(0);
      }
    } finally {
      await again.close();
    }
  }, 120_000);

  it("draws the tall post's contact inside the box its recorded reading gives", async (ctx) => {
    if (!browser) return ctx.skip();
    const tall = loadSyntheticPosts(POSTS).find((post) => post.id === "S12-tall-dubai")!;
    const record = JSON.parse(
      readFileSync(
        join(process.cwd(), "evals", "synthetic", "records", "S12-tall-dubai.json"),
        "utf8",
      ),
    ) as JobRecord;
    const { width, height } = tall.render;
    const tiles = tileSpans(width, height).map((span) => ({ image: 0, ...span, width }));
    const recorded = mapBox(record.roles[0]!.route.box, tiles)!;

    const drawn = (await lineBox(browser, tall, "Apply by email"))!;

    expect(drawn.left).toBeGreaterThanOrEqual(recorded.x1);
    expect(drawn.right).toBeLessThanOrEqual(recorded.x2);
    expect(drawn.top).toBeGreaterThanOrEqual(recorded.y1);
    expect(drawn.bottom).toBeLessThanOrEqual(recorded.y2);
  });

  it("refuses a post taller than its render size, which the screenshot would cut off", async (ctx) => {
    if (!browser) return ctx.skip();
    const long = {
      id: "X-long",
      text: "A line of a long post.\n".repeat(200),
      render: { width: 1080, height: 2400 },
    };

    await expect(renderPost(browser, long)).rejects.toThrow(/X-long.*taller/);
  });

  it("fills the tall post's screenshot with its words, down to the contact at its foot", async (ctx) => {
    if (!browser) return ctx.skip();
    const tall = loadSyntheticPosts(POSTS).find((post) => post.render.height > 2400)!;
    const cssHeight = tall.render.height / 3;

    const height = await postHeight(browser, tall);

    expect(height).toBeGreaterThan(0.9 * cssHeight);
    expect(height).toBeLessThanOrEqual(cssHeight);
  });
});
