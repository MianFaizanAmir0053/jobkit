/**
 * The `Storage` port on Supabase Storage, server side, with the project's
 * secret key. Signatures follow @supabase/storage-js 2.117:
 * https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl
 * Signed upload URLs are valid for a fixed two hours, set by Supabase.
 */
import { createClient } from "@supabase/supabase-js";

import type { Storage } from "@/core/ports";
import { assertStoragePath } from "@/server/storagePath";

export interface SupabaseStorage extends Storage {
  /** Creates the private bucket when it does not exist yet (run by the bootstrap). */
  ensureBucket(): Promise<void>;
}

export function createSupabaseStorage(opts: {
  url: string;
  secretKey: string;
  bucket: string;
}): SupabaseStorage {
  const client = createClient(opts.url, opts.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = () => client.storage.from(opts.bucket);
  const fail = (what: string, message: string): never => {
    throw new Error(`Supabase Storage ${what} failed: ${message}`);
  };
  // Storage reports a missing object as status 400 or 404 with "not found" in the message.
  const notFound = (error: { message: string; status?: number; statusCode?: string }) =>
    error.status === 404 || error.statusCode === "404" || /not.?found/i.test(error.message);

  async function listRecursive(prefix: string): Promise<string[]> {
    const { data, error } = await bucket().list(prefix, { limit: 1000 });
    if (error) return fail("list", error.message);
    const nested = await Promise.all(
      data.map((entry) =>
        entry.id === null
          ? listRecursive(`${prefix}/${entry.name}`)
          : Promise.resolve([`${prefix}/${entry.name}`]),
      ),
    );
    return nested.flat();
  }

  return {
    async createSignedUploadUrl(path) {
      assertStoragePath(path);
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: false });
      if (error) return fail("signed upload URL", error.message);
      return { url: data.signedUrl, token: data.token };
    },
    async createSignedReadUrl(path, expiresInSeconds) {
      assertStoragePath(path);
      const { data, error } = await bucket().createSignedUrl(path, expiresInSeconds);
      if (error) return fail("signed read URL", error.message);
      return data.signedUrl;
    },
    async put(path, bytes, contentType, options) {
      assertStoragePath(path);
      const { error } = await bucket().upload(path, bytes, {
        contentType,
        upsert: options?.overwrite ?? false,
      });
      if (error) fail("upload", error.message);
    },
    async get(path) {
      assertStoragePath(path);
      const { data, error } = await bucket().download(path);
      if (error) return notFound(error) ? null : fail("download", error.message);
      return data ? new Uint8Array(await data.arrayBuffer()) : null;
    },
    // Only a missing object is null: a passing server error must not read
    // as "absent", or the seed would try to upload over a stored CV.
    async stat(path) {
      assertStoragePath(path);
      const { data, error } = await bucket().info(path);
      if (error) return notFound(error) ? null : fail("stat", error.message);
      if (!data) return null;
      if (typeof data.size !== "number") return fail("stat", "storage gave no size");
      return { size: data.size };
    },
    async list(prefix) {
      assertStoragePath(prefix);
      return listRecursive(prefix);
    },
    async remove(paths) {
      paths.forEach(assertStoragePath);
      if (paths.length === 0) return;
      const { error } = await bucket().remove([...paths]);
      if (error) fail("remove", error.message);
    },
    async ensureBucket() {
      const existing = await client.storage.getBucket(opts.bucket);
      if (!existing.error) return;
      const { error } = await client.storage.createBucket(opts.bucket, { public: false });
      if (error) fail("create bucket", error.message);
    },
  };
}
