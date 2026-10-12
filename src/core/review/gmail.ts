import { isStrictAddress } from "@/core/extraction/contacts";

/**
 * The Gmail handoff on the laptop: a link that opens Gmail's compose window
 * in the owner's account (authuser), with the recipient, subject and body
 * filled in, for the owner to read and send. The address must pass the
 * strict check, which allows no character that could close the parameter or
 * add one; every value is encoded whole. The phone's handoff is Task 27's
 * (the spike chooses mailto or Web Share).
 */
export function gmailComposeUrl(
  to: string,
  subject: string,
  body: string,
  account: string | null = null,
): string {
  if (!isStrictAddress(to)) throw new Error("Only an address that passes the strict check");
  const params: [string, string][] = [
    ...(account === null ? [] : ([["authuser", account]] as [string, string][])),
    ["view", "cm"],
    ["fs", "1"],
    ["to", to],
    ["su", subject],
    ["body", body],
  ];
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `https://mail.google.com/mail/?${query}`;
}
