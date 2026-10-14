import { Google, OAuth2RequestError } from "arctic";

import type { GmailSender, GmailSendResult } from "@/core/ports";
import { within } from "@/lib/within";

/**
 * The Gmail port over the Gmail API (decisions A20): each send refreshes the
 * access token from the owner's refresh token, then uploads the MIME message
 * to users.messages.send, the documented way for a message with an
 * attachment. Each step has its own limit. Google refusing either step
 * means the owner must connect Gmail again, except a refusal for Gmail's
 * sending limits, which passes. A connection that drops once Gmail has the
 * message, or an error on Google's side, leaves it unknown whether it went;
 * anything else is a failure with its reason, and nothing was sent.
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 * https://developers.google.com/workspace/gmail/api/guides/uploads
 */

const UPLOAD_URL =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const TOKEN_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;
/** Gmail's words for a refusal under its sending limits, rather than for jobkit's access. */
const LIMITED =
  /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED|limit exceeded/i;
/** messages.send's upload limit, 35 MB, from the Gmail API's discovery document (mediaUpload.maxSize). */
export const MAX_MESSAGE_BYTES = 36_700_160;

export function createGmailSender(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
}): GmailSender {
  const google = new Google(opts.clientId, opts.clientSecret, opts.redirectUri);
  return {
    async send(message): Promise<GmailSendResult> {
      const bytes = new TextEncoder().encode(message);
      if (bytes.length > MAX_MESSAGE_BYTES) {
        return {
          ok: false,
          reason: "failed",
          message: "The email is larger than the 35 MB Gmail takes",
        };
      }
      let accessToken: string;
      try {
        const tokens = await within(
          google.refreshAccessToken(opts.refreshToken),
          TOKEN_TIMEOUT_MS,
          "Refreshing jobkit's access to Gmail",
        );
        accessToken = tokens.accessToken();
      } catch (error) {
        if (error instanceof OAuth2RequestError) {
          return {
            ok: false,
            reason: "unauthorised",
            message: `Google refused the token: ${error.code}`,
          };
        }
        return { ok: false, reason: "failed", message: messageOf(error) };
      }
      let response: Response;
      try {
        response = await fetch(UPLOAD_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "message/rfc822" },
          body: bytes,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        // The message may have reached Gmail before the connection dropped, so it may have gone.
        return { ok: false, reason: "unknown", message: messageOf(error) };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const said = `Gmail answered ${response.status}: ${text.slice(0, 300)}`;
        if (response.status === 429 || (response.status === 403 && LIMITED.test(text))) {
          return {
            ok: false,
            reason: "failed",
            message: `Gmail's sending limit was reached, so try again later (${said})`,
          };
        }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, reason: "unauthorised", message: said };
        }
        // Google's side erred: it may have sent the email first.
        if (response.status >= 500) return { ok: false, reason: "unknown", message: said };
        return { ok: false, reason: "failed", message: said };
      }
      const sent = (await response.json().catch(() => ({}))) as {
        id?: unknown;
        threadId?: unknown;
      };
      if (typeof sent.id !== "string") {
        return {
          ok: false,
          reason: "unknown",
          message: "Gmail took the email but gave no message ID",
        };
      }
      return {
        ok: true,
        messageId: sent.id,
        threadId: typeof sent.threadId === "string" ? sent.threadId : "",
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
