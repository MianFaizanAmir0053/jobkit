import { z } from "zod";

/**
 * Reads who signed in from the ID token Google's token endpoint returned.
 * The token arrives straight from Google over TLS, authenticated by the
 * client secret, so its signature need not be checked; the issuer, audience
 * and expiry still are, as Google's guide lists them:
 * https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
 * `sub` is the stable identifier; the email can change, so it only gates.
 */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export type IdentityRefusal = "malformed" | "wrong-issuer" | "wrong-audience" | "expired";

const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

const idTokenClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean(),
});

export function identityFromIdToken(
  claims: unknown,
  expect: { clientId: string; now: Date },
): { ok: true; identity: GoogleIdentity } | { ok: false; reason: IdentityRefusal } {
  const parsed = idTokenClaims.safeParse(claims);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const c = parsed.data;
  if (!GOOGLE_ISSUERS.includes(c.iss)) return { ok: false, reason: "wrong-issuer" };
  if (c.aud !== expect.clientId) return { ok: false, reason: "wrong-audience" };
  if (c.exp * 1000 <= expect.now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, identity: { sub: c.sub, email: c.email, emailVerified: c.email_verified } };
}
