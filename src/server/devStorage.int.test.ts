import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import { LIMITS } from "@/core/intake/limits";

import { acceptUpload, localRoutesAllowed, serveRead } from "./devStorage";

let root: string;
let storage: LocalStorage;
const DEV = { NODE_ENV: "development" } as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jobkit-devstorage-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  // The local adapter stamps read links with the system's time, as Supabase does.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;

function put(token: string, bytes: Uint8Array<ArrayBuffer>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/dev/storage/upload/${token}`, {
    method: "PUT",
    body: new Blob([bytes]),
  });
}

describe("the local storage routes", () => {
  it("store an upload sent with its token, once", async () => {
    const { url } = await storage.createSignedUploadUrl("jobs/j1/a.webp");
    const token = tokenOf(url);
    const bytes = new TextEncoder().encode("webp bytes");

    expect(
      (await acceptUpload(put(token, bytes), { storage, kind: "development" }, token)).status,
    ).toBe(200);
    expect(await storage.stat("jobs/j1/a.webp")).toEqual({ size: bytes.length });
    // A token works once, as a signed upload URL does.
    expect(
      (await acceptUpload(put(token, bytes), { storage, kind: "development" }, token)).status,
    ).toBe(404);
    expect(
      (await acceptUpload(put("unknown", bytes), { storage, kind: "development" }, "unknown"))
        .status,
    ).toBe(404);
  });

  it("refuse an unknown token before reading any of the body", async () => {
    const unread = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("the body was read");
      },
    });
    const request = new NextRequest(
      // A stream sent as a request body needs half duplex in Node.
      new Request("http://localhost:3000/api/dev/storage/upload/unknown", {
        method: "PUT",
        body: unread,
        duplex: "half",
      } as RequestInit),
    );

    expect((await acceptUpload(request, { storage, kind: "development" }, "unknown")).status).toBe(
      404,
    );
  });

  it("refuse a body larger than an image may be, keeping the token for the right file", async () => {
    const { url } = await storage.createSignedUploadUrl("jobs/j1/a.webp");
    const token = tokenOf(url);
    const deps = { storage, kind: "development" as const };

    const tooLarge = new Uint8Array(LIMITS.imageBytes + 1);
    expect((await acceptUpload(put(token, tooLarge), deps, token)).status).toBe(413);
    expect(await storage.stat("jobs/j1/a.webp")).toBeNull();

    const bytes = new TextEncoder().encode("webp bytes");
    expect((await acceptUpload(put(token, bytes), deps, token)).status).toBe(200);
  });

  it("refuse a token two hours old, as Supabase's signed upload URLs expire", async () => {
    const { url } = await storage.createSignedUploadUrl("jobs/j1/a.webp");
    const token = tokenOf(url);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);

    expect(
      (
        await acceptUpload(
          put(token, new TextEncoder().encode("late")),
          { storage, kind: "development" },
          token,
        )
      ).status,
    ).toBe(404);
  });

  it("serve a file through its read link, with its type, until the link expires", async () => {
    await storage.put("jobs/j1/a.webp", new TextEncoder().encode("webp bytes"), "image/webp");
    const token = tokenOf(await storage.createSignedReadUrl("jobs/j1/a.webp", 60));
    const deps = { storage, kind: "development" as const };

    const served = await serveRead(deps, token);

    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(new TextDecoder().decode(await served.arrayBuffer())).toBe("webp bytes");
    vi.advanceTimersByTime(61_000);
    expect((await serveRead(deps, token)).status).toBe(404);
  });

  it("answer only in a local dev server", () => {
    expect(localRoutesAllowed(DEV, "development")).toBe(true);
    expect(localRoutesAllowed(DEV, "test")).toBe(true);
    expect(localRoutesAllowed(DEV, "production")).toBe(false);
    expect(localRoutesAllowed({ NODE_ENV: "production" }, "development")).toBe(false);
    expect(localRoutesAllowed({ ...DEV, VERCEL: "1", VERCEL_ENV: "preview" }, "development")).toBe(
      false,
    );
  });
});
