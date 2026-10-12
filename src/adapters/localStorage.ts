/**
 * The `Storage` port on the local file system, for tests and local
 * development. Signed URLs point at development-only routes that call
 * `acceptSignedUpload` and `resolveSignedRead`; tokens live in memory.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { Storage } from "@/core/ports";
import { assertStoragePath } from "@/server/storagePath";

export interface LocalStorage extends Storage {
  /** The path a live upload token stands for, without using it up; null for an unknown, used or expired one. */
  uploadTarget(token: string, nowMs: number): string | null;
  /**
   * Stores the bytes for a live upload token. A token works once, as a signed
   * upload URL does: it is taken while the file is written, so a second
   * upload at the same moment finds it used, and given back if the write
   * fails, so the upload can be sent again. False for an unknown, used or
   * expired token.
   */
  acceptSignedUpload(token: string, bytes: Uint8Array, nowMs?: number): Promise<boolean>;
  /** The path a read token stands for, or null once it has expired. */
  resolveSignedRead(token: string, nowMs: number): string | null;
}

// A draft's name ends in "~", which no storage path may (see storagePath.ts), so no listing shows it.
const DRAFT = /~$/;

/**
 * Writes the whole file under a draft name, then gives it its own name in
 * one step, so a reader never sees part of a file, as with object storage.
 * Without `overwrite` the step is a hard link, which fails when the file is
 * already there; with it, a rename, which replaces it.
 */
async function writeWhole(file: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  const draft = `${file}.${randomBytes(6).toString("hex")}~`;
  await writeFile(draft, bytes, { flag: "wx" });
  try {
    if (overwrite) await rename(draft, file);
    else await link(draft, file);
  } finally {
    await rm(draft, { force: true });
  }
}

// The errors that mean no file is at the path: nothing there, a folder, or a file where a folder was expected.
const NO_FILE: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

// Supabase fixes a signed upload URL's validity at two hours.
const UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1000;

export function createLocalStorage(opts: { root: string; origin: string }): LocalStorage {
  const uploads = new Map<string, { path: string; expiresAtMs: number }>();
  const reads = new Map<string, { path: string; expiresAtMs: number }>();
  const fileFor = (path: string) => {
    assertStoragePath(path);
    return join(opts.root, ...path.split("/"));
  };
  const token = () => randomBytes(24).toString("base64url");
  const uploadTarget = (t: string, nowMs: number): string | null => {
    const upload = uploads.get(t);
    return upload && upload.expiresAtMs >= nowMs ? upload.path : null;
  };

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : Promise.resolve([join(dir, entry.name)]),
      ),
    );
    return nested.flat().filter((file) => !DRAFT.test(file));
  }

  return {
    async createSignedUploadUrl(path) {
      fileFor(path);
      const t = token();
      uploads.set(t, { path, expiresAtMs: Date.now() + UPLOAD_LIFETIME_MS });
      return { url: `${opts.origin}/api/dev/storage/upload/${t}`, token: t };
    },
    async createSignedReadUrl(path, expiresInSeconds) {
      fileFor(path);
      const t = token();
      reads.set(t, { path, expiresAtMs: Date.now() + expiresInSeconds * 1000 });
      return `${opts.origin}/api/dev/storage/read/${t}`;
    },
    uploadTarget,
    async acceptSignedUpload(t, bytes, nowMs = Date.now()) {
      const path = uploadTarget(t, nowMs);
      if (path === null) return false;
      // Taken before the write, so a second upload at the same moment finds it used,
      // and given back if the write fails, so the upload can be sent again.
      const upload = uploads.get(t)!;
      uploads.delete(t);
      const file = fileFor(path);
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeWhole(file, bytes, true);
      } catch (error) {
        uploads.set(t, upload);
        throw error;
      }
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
      await writeWhole(file, bytes, options?.overwrite === true).catch(
        (error: NodeJS.ErrnoException) => {
          throw error.code === "EEXIST" ? new Error(`${path} already exists in storage`) : error;
        },
      );
    },
    async get(path) {
      return readFile(fileFor(path)).then(
        (buffer) => new Uint8Array(buffer),
        (error: NodeJS.ErrnoException) => {
          if (NO_FILE.has(error.code ?? "")) return null;
          throw error;
        },
      );
    },
    async stat(path) {
      return stat(fileFor(path)).then(
        (s) => (s.isFile() ? { size: s.size } : null),
        (error: NodeJS.ErrnoException) => {
          if (NO_FILE.has(error.code ?? "")) return null;
          throw error;
        },
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
