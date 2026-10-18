import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { linksIn } from "./links";

/*
 * The share target's worker (public/sw.js, intake spec "Inputs"), run in a
 * context of its own as a browser runs it, for what it refuses before a share
 * is kept. Its link rules are a copy of links.ts, which a worker cannot
 * import; these tests hold the two together.
 */

interface Worker {
  linksIn(text: string): { found: string[]; words: number };
  refusalOf(share: {
    images: { size: number }[];
    title: string;
    text: string;
    url: string;
  }): string | null;
}

function worker(): Worker {
  const source = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
  const context = {
    self: { addEventListener: () => undefined, location: { origin: "http://localhost:3000" } },
    URL,
    URLSearchParams,
    Response,
    AbortSignal,
  };
  runInNewContext(source, context);
  return context as unknown as Worker;
}

const share = (parts: Partial<Parameters<Worker["refusalOf"]>[0]>) => ({
  images: [],
  title: "",
  text: "",
  url: "",
  ...parts,
});

describe("the share target's worker", () => {
  it("finds the links links.ts finds, so a share is judged as its job will read", () => {
    const char = (code: number) => String.fromCharCode(code);
    const texts = [
      "Apply: https://www.linkedin.com/jobs/view/4012345678/?ref=feed. See www.acme.example/careers, " +
        "or (https://jobs.example.com/a). Docs: https://en.example.org/wiki/Go_(language).",
      `Apply ${char(0x201c)}https://x.example/job${char(0x201d)} or https://jobs.example.pk/1${char(0x060c)} ` +
        `https://a.example/x${char(0x3001)}next https://c.example/z${char(0x200f)}`,
      `https://lnkd.in/abc${char(0x200b)}Apply now`,
      "Apply here...https://lnkd.in/abc",
      "Write to jobs@www.acme.example or hr@acme.example. Our host is mail.www.acme.example",
      "See https://, we are hiring",
      `https://lnkd.in/${"x".repeat(2_100)} and https://b.example`,
    ];
    const sw = worker();
    for (const text of texts) expect(sw.linksIn(text).found).toEqual(linksIn(text));
  });

  it("refuses a share with nothing in it, or only a url field holding no link", () => {
    const sw = worker();
    expect(sw.refusalOf(share({}))).toBe("empty");
    expect(sw.refusalOf(share({ url: "Northwind" }))).toBe("empty");
  });

  it("refuses a link with a few words around it, in the text, the url field or the title alone", () => {
    const sw = worker();
    expect(sw.refusalOf(share({ text: "https://www.linkedin.com/posts/northwind-123" }))).toBe(
      "link",
    );
    expect(
      sw.refusalOf(share({ text: "Check out this job at Northwind: https://acme.example/1" })),
    ).toBe("link");
    expect(
      sw.refusalOf(share({ title: "Senior Engineer at Acme", url: "https://acme.example/1" })),
    ).toBe("link");
    expect(sw.refusalOf(share({ title: "https://lnkd.in/x" }))).toBe("link");
  });

  it("refuses LinkedIn's share of a job, whose company and title make more words", () => {
    const sw = worker();
    expect(
      sw.refusalOf(
        share({
          text:
            "Check out this job at Systems Limited: Senior Software Engineer - React Native (Remote) " +
            "https://www.linkedin.com/jobs/view/4012345678",
        }),
      ),
    ).toBe("link");
    // The same words around another site's link are a short post of their own.
    expect(
      sw.refusalOf(
        share({
          text:
            "Check out this job at Systems Limited: Senior Software Engineer - React Native (Remote) " +
            "https://careers.example.com/4012345678",
        }),
      ),
    ).toBeNull();
  });

  it("keeps a short post naming an email address, a post with no link, and any screenshots", () => {
    const sw = worker();
    expect(
      sw.refusalOf(share({ text: "Send CV: jobs@www.acme.example https://acme.example/jobs" })),
    ).toBeNull();
    expect(sw.refusalOf(share({ text: "See https://, we are hiring" }))).toBeNull();
    expect(sw.refusalOf(share({ text: "Northwind is hiring" }))).toBeNull();
    expect(
      sw.refusalOf(share({ images: [{ size: 1_000 }], text: "https://lnkd.in/x" })),
    ).toBeNull();
  });

  it("refuses a share larger than jobkit takes, counting the title and text as they are joined", () => {
    const sw = worker();
    const image = { size: 1_000 };
    expect(sw.refusalOf(share({ images: Array.from({ length: 9 }, () => image) }))).toBe("big");
    expect(sw.refusalOf(share({ images: [{ size: 40 * 1024 * 1024 + 1 }] }))).toBe("big");
    expect(sw.refusalOf(share({ title: "a".repeat(10_000), text: "b".repeat(10_000) }))).toBe(
      "big",
    );
    expect(sw.refusalOf(share({ title: "a".repeat(9_999), text: "b".repeat(10_000) }))).toBeNull();
    expect(sw.refusalOf(share({ images: Array.from({ length: 8 }, () => image) }))).toBeNull();
  });
});
