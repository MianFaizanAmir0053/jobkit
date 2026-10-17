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

  it("finds nothing in text with no address, and no address that is only its start", () => {
    expect(linksIn("We're hiring a React developer. Email jobs@example.com.")).toEqual([]);
    expect(linksIn("https:// www. http://")).toEqual([]);
  });
});
