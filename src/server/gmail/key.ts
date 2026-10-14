import { keyFrom } from "./seal";

/** GMAIL_TOKEN_KEY, which seals the Gmail refresh token (decisions A20); null when it is not set or not 32 bytes. */
export function gmailTokenKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Buffer | null {
  return keyFrom(env.GMAIL_TOKEN_KEY);
}
