import { describe, expect, it } from "vitest";

import { applicationLink, whatsAppLink } from "./links";

/* The handoff links of form and message kits: review spec, acceptance criterion 8. */

describe("whatsAppLink", () => {
  it("opens WhatsApp on the normalised number with the message encoded", () => {
    expect(whatsAppLink("0300 1234567", "Hello & thanks,\nSam")).toBe(
      "https://wa.me/923001234567?text=Hello%20%26%20thanks%2C%0ASam",
    );
    expect(whatsAppLink("+44 7700 900123", "Hi")).toBe("https://wa.me/447700900123?text=Hi");
  });

  it("gives no link for a number that does not normalise", () => {
    expect(whatsAppLink("12345", "Hi")).toBeNull();
    expect(whatsAppLink("", "Hi")).toBeNull();
  });

  it("drops half of a broken pair rather than throwing on it", () => {
    const half = String.fromCharCode(0xd800);
    expect(whatsAppLink("03001234567", `Hi${half} there`)).toBe(
      "https://wa.me/923001234567?text=Hi%20there",
    );
  });
});

describe("applicationLink", () => {
  it("opens the address as shown, but for the case of its host and a closing slash", () => {
    expect(applicationLink("https://Jobs.Example.com/Apply")).toBe(
      "https://jobs.example.com/Apply",
    );
    expect(applicationLink("https://jobs.example.com")).toBe("https://jobs.example.com/");
    // The page shows the address as the parser reads it, and opens that.
    expect(applicationLink("https://jobs.example.com:443?ref=post#apply")).toBe(
      "https://jobs.example.com/?ref=post#apply",
    );
  });

  it("gives the post's link to apply through only when it is https", () => {
    expect(applicationLink(" https://jobs.example.com/apply?id=7 ")).toBe(
      "https://jobs.example.com/apply?id=7",
    );
    for (const address of [
      "http://jobs.example.com/apply",
      "javascript:alert(1)",
      "data:text/html,hi",
      "jobs.example.com/apply",
      "https://user:secret@jobs.example.com/apply",
      "",
      // The parser drops what is inside, opening jobs.acme.com.evil.io, not the address shown.
      `https://jobs.acme.com${String.fromCharCode(9)}.evil.io/apply`,
      `https://jobs.acme.com${String.fromCharCode(10)}.evil.io/apply`,
      "https://jobs.acme.com .evil.io/apply",
      `https://jobs.acme.com${String.fromCharCode(0)}.evil.io/apply`,
      // A look-alike slash or dot, or one written with a percent sign, opens another host.
      `https://careers.google.com${String.fromCharCode(0x2044)}apply.evil.example/`,
      `https://boards.greenhouse.io${String.fromCharCode(0x3002)}evil.example/jobs`,
      "https://boards.greenhouse.io%2eevil.example/jobs",
      "https://jobs.example.com\\@evil.example/",
    ]) {
      expect(applicationLink(address)).toBeNull();
    }
  });
});
