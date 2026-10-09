/**
 * The `Storage` port on the local file system, for tests and local
 * development. Signed URLs point at development-only routes that call
 * `acceptSignedUpload` and `resolveSignedRead`; tokens live in memory.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { Storage } from "@/core/ports";
import { assertStoragePath } from "@/server/storagePath";

export interface LocalStorage extends Storage {
  /** Stores the bytes for an upload token once; false for an unknown or used token. */
  acceptSignedUpload(token: string, bytes: Uint8Array): Promise<boolean>;
  /** The path a read token stands for, or null once it has expired. */
  resolveSignedRead(token: string, nowMs: number): string | null;
}

export function createLocalStorage(opts: { root: string; origin: string }): LocalStorage {
  const uploads = new Map<string, string>();
  const reads = new Map<string, { path: string; expiresAtMs: number }>();
  const fileFor = (path: string) => {
    assertStoragePath(path);
    return join(opts.root, ...path.split("/"));
  };
  const token = () => randomBytes(24).toString("base64url");

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : Promise.resolve([join(dir, entry.name)]),
      ),
    );
    return nested.flat();
  }

  return {
    async createSignedUploadUrl(path) {
      fileFor(path);
      const t = token();
      uploads.set(t, path);
      return { url: `${opts.origin}/api/dev/storage/upload/${t}`, token: t };
    },
    async createSignedReadUrl(path, expiresInSeconds) {
      fileFor(path);
      const t = token();
      reads.set(t, { path, expiresAtMs: Date.now() + expiresInSeconds * 1000 });
      return `${opts.origin}/api/dev/storage/read/${t}`;
    },
    async acceptSignedUpload(t, bytes) {
      const path = uploads.get(t);
      if (!path) return false;
      uploads.delete(t);
      const file = fileFor(path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return true;
    },
    resolveSignedRead(t, nowMs) {
      const read = reads.get(t);
      return read && read.expiresAtMs >= nowMs ? read.path : null;
    },
    // Like Supabase Storage, a file already there is replaced only when asked.
    async put(path, bytes, _contentType, options) {
      const file = fileFor(path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: options?.overwrite ? "w" : "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          throw error.code === "EEXIST" ? new Error(`${path} already exists in storage`) : error;
        },
      );
    },
    async get(path) {
      return readFile(fileFor(path)).then(
        (buffer) => new Uint8Array(buffer),
        () => null,
      );
    },
    async stat(path) {
      return stat(fileFor(path)).then(
        (s) => (s.isFile() ? { size: s.size } : null),
        () => null,
      );
    },
    async list(prefix) {
      const files = await walk(fileFor(prefix));
      return files.map((file) => relative(opts.root, file).split(sep).join("/"));
    },
    async remove(paths) {
      await Promise.all(paths.map((path) => rm(fileFor(path), { force: true })));
    },
  };
}
