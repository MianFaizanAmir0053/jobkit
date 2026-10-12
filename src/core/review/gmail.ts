import { isStrictAddress } from "@/core/extraction/contacts";

/**
 * The Gmail handoff on the laptop: a link that opens Gmail's compose window
 * with the recipient, subject and body filled in, for the owner to read and
 * send. The address must pass the strict check, which allows no character
 * that could close the parameter or add one; the subject and body are
 * encoded whole. The phone's handoff is Task 27's (the spike chooses it).
 */
export function gmailComposeUrl(to: string, subject: string, body: string): string {
  if (!isStrictAddress(to)) throw new Error("Only an address that passes the strict check");
  const params = [
    ["view", "cm"],
    ["fs", "1"],
    ["to", to],
    ["su", subject],
    ["body", body],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
    .join("&");
  return `https://mail.google.com/mail/?${params}`;
}
