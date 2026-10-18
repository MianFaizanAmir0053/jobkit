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
    ]) {
      expect(applicationLink(address)).toBeNull();
    }
  });
});
