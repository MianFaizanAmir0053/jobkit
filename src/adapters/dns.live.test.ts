import { describe, expect, it } from "vitest";

import { createDns } from "./dns";

/*
 * The DNS adapter against the real DNS (run with `npm run test:live`; it
 * costs nothing). example.com publishes a null MX (RFC 7505), so it shows
 * how the resolver reports one.
 */

describe("createDns, live", () => {
  const dns = createDns();

  it("finds a mail host's MX records", async () => {
    const answer = await dns.lookup("gmail.com", "MX");

    expect(answer.kind).toBe("records");
  });

  it("reports example.com's null MX as one empty or root exchange", async () => {
    const answer = await dns.lookup("example.com", "MX");

    expect(answer).toMatchObject({ kind: "records" });
    const values = answer.kind === "records" ? answer.values : [];
    expect(values).toHaveLength(1);
    expect(["", "."]).toContain(values[0]);
  });

  it("has none for a name that does not exist", async () => {
    expect(await dns.lookup("no-such-name.invalid", "MX")).toEqual({ kind: "none" });
    expect(await dns.lookup("no-such-name.invalid", "A")).toEqual({ kind: "none" });
  });

  it("finds an address record", async () => {
    expect((await dns.lookup("example.com", "A")).kind).toBe("records");
  });
});
