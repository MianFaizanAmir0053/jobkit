import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "./manifest";

describe("the web app manifest", () => {
  it("opens jobkit's jobs list as an installed app", () => {
    expect(manifest()).toMatchObject({
      name: "jobkit",
      start_url: "/jobs",
      display: "standalone",
    });
  });

  it("declares the share target the intake spec asks for", () => {
    expect(manifest().share_target).toEqual({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "images", accept: ["image/*"] }],
      },
    });
  });

  it("lists 192- and 512-pixel icons that exist, one of them maskable", () => {
    const icons = manifest().icons ?? [];

    expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of icons) expect(existsSync(join("public", icon.src))).toBe(true);
  });
});
