import { createHash, createHmac } from "node:crypto";

/** Base64url without padding, safe in cookies and URL fragments. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hmacSha256(key: Uint8Array, text: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(text, "utf8").digest());
}
