import { fakeGmail, type FakeGmail } from "@/adapters/fakeGmail";
import { createGmailSender } from "@/adapters/gmail";
import type { Db, GmailSender } from "@/core/ports";
import type { AppConfig } from "@/server/config";
import type { Container } from "@/server/container";

import { gmailConnection, gmailRefreshToken } from "./connection";
import { gmailTokenKey } from "./key";

/**
 * The owner's connected Gmail as a sender (decisions A20): the Gmail API,
 * with the refresh token kept for it, opened with GMAIL_TOKEN_KEY; on the
 * test server, a fake that sends nothing. Null while Gmail is not
 * connected, or when the key cannot open the token, so the owner connects
 * again.
 */

const shared = globalThis as typeof globalThis & { jobkitTestGmail?: FakeGmail };

/** The test server's Gmail, kept on globalThis, as its models are, across the dev server's reloads. */
export function testGmail(): FakeGmail {
  shared.jobkitTestGmail ??= fakeGmail();
  return shared.jobkitTestGmail;
}

/** Forgets what the test server's Gmail was given, and how it answers. */
export function resetTestGmail(): void {
  shared.jobkitTestGmail = fakeGmail();
}

export async function connectedGmail(deps: {
  db: Db;
  kind: Container["kind"];
  config: AppConfig;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<GmailSender | null> {
  if (!(await gmailConnection(deps.db))) return null;
  if (deps.kind === "test") return testGmail();
  const key = gmailTokenKey(deps.env);
  if (!key) return null;
  const refreshToken = await gmailRefreshToken(deps.db, key);
  if (!refreshToken) return null;
  return createGmailSender({
    clientId: deps.config.google.clientId,
    clientSecret: deps.config.google.clientSecret,
    redirectUri: `${deps.config.appOrigin}/api/auth/google/callback`,
    refreshToken,
  });
}
