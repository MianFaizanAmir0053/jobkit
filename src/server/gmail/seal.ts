import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secrets kept at rest (decisions A20): AES-256-GCM under GMAIL_TOKEN_KEY, a
 * 32-byte key written as base64. A sealed value is base64 of the 12-byte IV,
 * the ciphertext and the 16-byte tag, so opening one sealed under another
 * key, or altered in any byte, throws rather than returning anything.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key from its base64 form; null unless it is exactly 32 bytes. */
export function keyFrom(text: string | undefined): Buffer | null {
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const key = Buffer.from(text, "base64");
  return key.length === 32 ? key : null;
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function openSealed(sealed: string, key: Buffer): string {
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("The sealed value is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
