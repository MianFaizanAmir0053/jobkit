import { join } from "node:path";

import { type Browser, chromium } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSyntheticPosts, postHtml, renderPost } from "./render";

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
});
