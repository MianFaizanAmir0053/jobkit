/**
 * Live contract test against the real Supabase Storage bucket.
 * Runs only with `npm run test:live`, by hand, with .env.ops.local filled in.
 */
import { afterAll, describe, expect, it } from "vitest";

import { BUCKET } from "@/server/container";

import { loadOpsEnv } from "../../scripts/ops";
import { createSupabaseStorage } from "./supabaseStorage";

const env = loadOpsEnv();
const storage = createSupabaseStorage({
  url: env.SUPABASE_URL!,
  secretKey: env.SUPABASE_SECRET_KEY!,
  bucket: BUCKET,
});
const prefix = `live-test/${Date.now().toString(36)}`;

afterAll(async () => {
  await storage.remove(await storage.list(prefix));
}, 60_000);

describe("Supabase Storage", () => {
  it("stores, sizes, reads, lists and removes a file", async () => {
    await storage.put(`${prefix}/a.txt`, new TextEncoder().encode("hello"), "text/plain");

    expect(await storage.stat(`${prefix}/a.txt`)).toEqual({ size: 5 });
    expect(new TextDecoder().decode((await storage.get(`${prefix}/a.txt`))!)).toBe("hello");
    expect(await storage.list(prefix)).toEqual([`${prefix}/a.txt`]);
  }, 60_000);

  it("says a missing object is absent, and replaces an object only when asked", async () => {
    expect(await storage.stat(`${prefix}/missing.txt`)).toBeNull();
    await storage.put(`${prefix}/c.txt`, new TextEncoder().encode("one"), "text/plain");

    await expect(
      storage.put(`${prefix}/c.txt`, new TextEncoder().encode("two"), "text/plain"),
    ).rejects.toThrow(/upload failed/);
    await storage.put(`${prefix}/c.txt`, new TextEncoder().encode("three"), "text/plain", {
      overwrite: true,
    });
    expect(await storage.stat(`${prefix}/c.txt`)).toEqual({ size: 5 });
  }, 60_000);

  it("issues signed upload and read URLs on the project's domain", async () => {
    const upload = await storage.createSignedUploadUrl(`${prefix}/b.txt`);
    const read = await storage.createSignedReadUrl(`${prefix}/a.txt`, 60);

    expect(new URL(upload.url).hostname).toBe(new URL(env.SUPABASE_URL!).hostname);
    expect(new URL(read).hostname).toBe(new URL(env.SUPABASE_URL!).hostname);
  }, 60_000);
});
