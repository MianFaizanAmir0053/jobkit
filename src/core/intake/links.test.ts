import { describe, expect, it } from "vitest";

import { linksIn, MAX_LINKS } from "./links";

/* The links a post gives, kept as a reference and never fetched (intake spec, "Inputs"). */

describe("linksIn", () => {
  it("finds each web address as written, without the sentence marks around it", () => {
    expect(
      linksIn(
        "Apply: https://www.linkedin.com/jobs/view/4012345678/?ref=feed. See www.acme.example/careers, " +
          "or (https://jobs.example.com/a). Docs: https://en.example.org/wiki/Go_(language).",
      ),
    ).toEqual([
      "https://www.linkedin.com/jobs/view/4012345678/?ref=feed",
      "www.acme.example/careers",
      "https://jobs.example.com/a",
      "https://en.example.org/wiki/Go_(language)",
    ]);
  });

  it("keeps a link once, the share's first, and no more than the limit", () => {
    expect(linksIn("https://lnkd.in/a", "again https://lnkd.in/a and http://b.example")).toEqual([
      "https://lnkd.in/a",
      "http://b.example",
    ]);
    const many = Array.from({ length: MAX_LINKS + 3 }, (_, n) => `https://x.example/${n}`);
    expect(linksIn(many.join(" "))).toEqual(many.slice(0, MAX_LINKS));
  });

  it("ends a link at an invisible character, takes no sentence mark of any script, and keeps a bracket it opened", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    expect(
      linksIn(
        `Apply: https://lnkd.in/abc${zeroWidth}Apply now. Urdu: https://jobs.example.pk/1${String.fromCharCode(0x06d4)} ` +
          `Japanese: https://jobs.example.jp/2${String.fromCharCode(0x3002)} More: https://a.example/3${String.fromCharCode(0x2026)} ` +
          "Wiki: http://a.example/[id] and [https://b.example/x].",
      ),
    ).toEqual([
      "https://lnkd.in/abc",
      "https://jobs.example.pk/1",
      "https://jobs.example.jp/2",
      "https://a.example/3",
      "http://a.example/[id]",
      "https://b.example/x",
    ]);
  });

  it("leaves out closing quotes and the marks of Urdu, Chinese and Japanese, and stops at direction marks", () => {
    const char = (code: number) => String.fromCharCode(code);
    expect(
      linksIn(
        `Apply ${char(0x201c)}https://x.example/job${char(0x201d)} or https://jobs.example.pk/1${char(0x060c)} ` +
          `https://jobs.example.pk/2${char(0x061f)} https://a.example/x${char(0x3001)}next ` +
          `https://b.example/y${char(0xff0c)}more https://c.example/z${char(0x200f)} ` +
          `${char(0x00ab)}https://d.example/w${char(0x00bb)}`,
      ),
    ).toEqual([
      "https://x.example/job",
      "https://jobs.example.pk/1",
      "https://jobs.example.pk/2",
      "https://a.example/x",
      "https://b.example/y",
      "https://c.example/z",
      "https://d.example/w",
    ]);
  });

  it("finds a link right after a sentence's dots, but none inside a domain or an email address", () => {
    expect(linksIn("Apply here...https://lnkd.in/abc")).toEqual(["https://lnkd.in/abc"]);
    expect(linksIn("Write to jobs@www.acme.example or hr@acme.example.")).toEqual([]);
    expect(linksIn("Our host is mail.www.acme.example")).toEqual([]);
  });

  it("finds nothing in text with no address, and no address that is only its start", () => {
    expect(linksIn("We're hiring a React developer. Email jobs@example.com.")).toEqual([]);
    expect(linksIn("https:// www. http://")).toEqual([]);
  });
});
