import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalStorage, type LocalStorage } from "./localStorage";

let root: string;
let storage: LocalStorage;

const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jobkit-storage-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("local storage", () => {
  it("stores, reads, sizes and removes a file", async () => {
    await storage.put("jobs/j1/a.webp", bytes("hello"), "image/webp");

    expect(new TextDecoder().decode((await storage.get("jobs/j1/a.webp"))!)).toBe("hello");
    expect(await storage.stat("jobs/j1/a.webp")).toEqual({ size: 5 });

    await storage.remove(["jobs/j1/a.webp"]);
    expect(await storage.get("jobs/j1/a.webp")).toBeNull();
    expect(await storage.stat("jobs/j1/a.webp")).toBeNull();
  });

  it("replaces a file only when asked, as Supabase Storage does", async () => {
    await storage.put("profile/cv.pdf", bytes("one"), "application/pdf");

    await expect(storage.put("profile/cv.pdf", bytes("two"), "application/pdf")).rejects.toThrow(
      "profile/cv.pdf already exists in storage",
    );
    await storage.put("profile/cv.pdf", bytes("three"), "application/pdf", { overwrite: true });
    expect(new TextDecoder().decode((await storage.get("profile/cv.pdf"))!)).toBe("three");
  });

  it("never shows a file half written: a put that loses a race finds the winner's file whole", async () => {
    // Large enough that writing it takes a moment, as a CV does.
    const big = new Uint8Array(4 * 1024 * 1024).fill(7);
    const seen: (number | undefined)[] = [];

    for (let round = 0; round < 10; round++) {
      const path = `profile/cv-${round}.pdf`;
      await Promise.all(
        [0, 1].map(() =>
          storage.put(path, big, "application/pdf").catch(async () => {
            seen.push((await storage.stat(path))?.size);
          }),
        ),
      );
    }

    expect(seen).toEqual(Array(10).fill(big.length));
  });

  it("lists the files under a prefix", async () => {
    await storage.put("jobs/j1/a.webp", bytes("a"), "image/webp");
    await storage.put("jobs/j1/crops/c.png", bytes("c"), "image/png");
    await storage.put("jobs/j2/b.webp", bytes("b"), "image/webp");

    expect((await storage.list("jobs/j1")).sort()).toEqual([
      "jobs/j1/a.webp",
      "jobs/j1/crops/c.png",
    ]);
  });

  it("accepts an upload only with the token issued for that path", async () => {
    const { url, token } = await storage.createSignedUploadUrl("jobs/j1/a.webp");
    expect(url.startsWith("http://localhost:3000/")).toBe(true);

    expect(await storage.acceptSignedUpload("wrong-token", bytes("x"))).toBe(false);
    expect(await storage.acceptSignedUpload(token, bytes("x"))).toBe(true);
    expect(await storage.stat("jobs/j1/a.webp")).toEqual({ size: 1 });
    // A token works once.
    expect(await storage.acceptSignedUpload(token, bytes("y"))).toBe(false);
  });

  it("issues read URLs that resolve to the file only until they expire", async () => {
    await storage.put("jobs/j1/a.webp", bytes("a"), "image/webp");
    const url = await storage.createSignedReadUrl("jobs/j1/a.webp", 60);
    const token = new URL(url).pathname.split("/").pop()!;

    expect(storage.resolveSignedRead(token, Date.now())).toBe("jobs/j1/a.webp");
    expect(storage.resolveSignedRead(token, Date.now() + 61_000)).toBeNull();
  });

  it.each([
    "../escape.txt",
    "jobs/../../x",
    "/abs/path",
    "jobs\\j1\\a.webp",
    "",
    "jobs/j1/ a.webp",
  ])("refuses the unsafe path %j", async (path) => {
    await expect(storage.put(path, bytes("x"), "text/plain")).rejects.toThrow(/storage path/);
  });
});
