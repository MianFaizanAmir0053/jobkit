import { describe, expect, it } from "vitest";

import { gmailComposeUrl } from "./gmail";

/* The laptop's Gmail handoff: nothing in the subject or body can add a parameter or a recipient. */

describe("gmailComposeUrl", () => {
  it("opens Gmail's compose window with the recipient, subject and body", () => {
    const url = new URL(
      gmailComposeUrl(
        "jobs@example.com",
        "Application: Engineer – Sam",
        "Dear Hiring Team,\n\nHello & thanks.",
      ),
    );

    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect([...url.searchParams]).toEqual([
      ["view", "cm"],
      ["fs", "1"],
      ["to", "jobs@example.com"],
      ["su", "Application: Engineer – Sam"],
      ["body", "Dear Hiring Team,\n\nHello & thanks."],
    ]);
  });

  it("keeps a subject or body that tries to add a parameter inside its own", () => {
    const url = new URL(gmailComposeUrl("jobs@example.com", "Hi&bcc=x@evil.com", "a#b?c=d"));

    expect(url.searchParams.get("bcc")).toBeNull();
    expect(url.searchParams.get("su")).toBe("Hi&bcc=x@evil.com");
    expect(url.searchParams.get("body")).toBe("a#b?c=d");
    expect(url.hash).toBe("");
  });

  it("keeps one recipient and no extra header for a subject or body holding %0ABcc: or %2C (review AC7)", () => {
    const url = new URL(
      gmailComposeUrl(
        "jobs@example.com",
        "Hi%0ABcc: x@evil.com",
        "Hi%2C x@evil.com\nBcc: y@evil.com",
      ),
    );

    expect(url.searchParams.getAll("to")).toEqual(["jobs@example.com"]);
    expect(url.searchParams.get("bcc")).toBeNull();
    expect(url.searchParams.get("cc")).toBeNull();
    expect(url.searchParams.get("su")).toBe("Hi%0ABcc: x@evil.com");
    expect(url.searchParams.get("body")).toBe("Hi%2C x@evil.com\nBcc: y@evil.com");
  });

  it("refuses an address that fails the strict check", () => {
    expect(() => gmailComposeUrl("jobs@example.com&bcc=x@evil.com", "s", "b")).toThrow();
    expect(() => gmailComposeUrl("jobs@example.com?cc=x@evil.com", "s", "b")).toThrow();
    expect(() => gmailComposeUrl("jobs@example.com%2Cx@evil.com", "s", "b")).toThrow();
    expect(() => gmailComposeUrl("jobs@example.com%0ABcc:x@evil.com", "s", "b")).toThrow();
  });

  it("opens compose in the owner's Google account when given one", () => {
    const url = new URL(gmailComposeUrl("jobs@example.com", "s", "b", "owner@example.com"));

    expect(url.searchParams.get("authuser")).toBe("owner@example.com");
    expect(url.searchParams.get("to")).toBe("jobs@example.com");
  });
});
