/**
 * Storage paths are built by code (`jobs/<jobId>/<imageId>.webp`) and checked
 * here before any adapter touches them, so none can escape its folder.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertStoragePath(path: string): void {
  const segments = path.split("/");
  const safe =
    path.length > 0 &&
    path.length <= 512 &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");
  if (!safe) throw new Error(`Unsafe storage path ${JSON.stringify(path)}`);
}
