import { describe, expect, it } from "vitest";

import type { Dns, DnsAnswer } from "@/core/ports";

import { type AddressCheck, checkAddress, companyMatches, mailHostOf } from "./addressChecks";

/* The address checks with a fake DNS: review AC5. */

/** A DNS that answers from a table, by "name type"; anything unlisted has no records. */
function fakeDns(table: Record<string, DnsAnswer>): Dns & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async lookup(name, type) {
      asked.push(`${name} ${type}`);
      return table[`${name} ${type}`] ?? { kind: "none" };
    },
  };
}

const records = (...values: string[]): DnsAnswer => ({ kind: "records", values });

const kinds = (checks: readonly AddressCheck[]) =>
  checks.map(({ kind, blocking }) => [kind, blocking ? "blocks" : "warns"]);

describe("mailHostOf", () => {
  it("passes an MX record, and an A or AAAA record when there is no MX", async () => {
    expect(await mailHostOf(fakeDns({ "acme.com MX": records("mx.acme.com") }), "acme.com")).toBe(
      "mx",
    );
    expect(await mailHostOf(fakeDns({ "acme.com A": records("192.0.2.1") }), "acme.com")).toBe(
      "implicit_mx",
    );
    expect(await mailHostOf(fakeDns({ "acme.com AAAA": records("2001:db8::1") }), "acme.com")).toBe(
      "implicit_mx",
    );
  });

  it("finds a null MX, which takes no mail, and a domain with no records at all", async () => {
    expect(await mailHostOf(fakeDns({ "acme.com MX": records("") }), "acme.com")).toBe("null_mx");
    expect(await mailHostOf(fakeDns({ "acme.com MX": records(".") }), "acme.com")).toBe("null_mx");
    expect(await mailHostOf(fakeDns({}), "acme.com")).toBe("none");
  });

  it("could not check after a timeout or another failure", async () => {
    expect(await mailHostOf(fakeDns({ "acme.com MX": { kind: "timeout" } }), "acme.com")).toBe(
      "unchecked",
    );
    expect(
      await mailHostOf(fakeDns({ "acme.com A": { kind: "failed" } }), "acme.com"),
    ).toBe("unchecked");
  });
});

describe("checkAddress", () => {
  const mx = fakeDns({ "northwind.com MX": records("mx.northwind.com") });

  it("raises nothing for a company address with a mail server", async () => {
    expect(await checkAddress(mx, "jobs@northwind.com", "Northwind Analytics")).toEqual([]);
  });

  it("blocks an address that fails the strict check, without asking the DNS", async () => {
    const dns = fakeDns({});

    expect(kinds(await checkAddress(dns, "hr@acme.com?bcc=x@evil.com", "Acme"))).toEqual([
      ["syntax", "blocks"],
    ]);
    expect(dns.asked).toEqual([]);
  });

  it("blocks a null MX and an unknown domain, and warns when the DNS times out", async () => {
    expect(
      kinds(await checkAddress(fakeDns({ "acme.com MX": records(".") }), "hr@acme.com", "Acme")),
    ).toEqual([["mail_host", "blocks"]]);
    expect(kinds(await checkAddress(fakeDns({}), "hr@acme.com", "Acme"))).toEqual([
      ["mail_host", "blocks"],
    ]);
    const slow = fakeDns({ "acme.com MX": { kind: "timeout" } });
    const checks = await checkAddress(slow, "hr@acme.com", "Acme");
    expect(kinds(checks)).toEqual([["mail_host", "warns"]]);
    expect(checks[0]!.message).toBe("Couldn't check the mail server.");
  });

  it("warns about free mail, and about a domain unlike the company's name, but never blocks for them", async () => {
    const gmail = fakeDns({ "gmail.com MX": records("gmail-smtp-in.l.google.com") });
    expect(kinds(await checkAddress(gmail, "northwind.hiring@gmail.com", "Northwind"))).toEqual([
      ["free_mail", "warns"],
    ]);
    const yahoo = fakeDns({ "yahoo.co.uk MX": records("mx.yahoo.co.uk") });
    expect(kinds(await checkAddress(yahoo, "hr@yahoo.co.uk", "Northwind"))).toEqual([
      ["free_mail", "warns"],
    ]);
    const agency = fakeDns({ "talentbridge.io MX": records("mx.talentbridge.io") });
    expect(kinds(await checkAddress(agency, "jobs@talentbridge.io", "Northwind Analytics"))).toEqual(
      [["company", "warns"]],
    );
  });

  it("asks the DNS about the address's own domain", async () => {
    const dns = fakeDns({ "mail.northwind.com MX": records("mx.northwind.com") });

    expect(await checkAddress(dns, "jobs@mail.northwind.com", "Northwind")).toEqual([]);
    expect(dns.asked).toEqual(["mail.northwind.com MX"]);
  });
});

describe("companyMatches", () => {
  it("matches a domain naming the company, however it is spaced or suffixed", () => {
    expect(companyMatches("northwind.com", "Northwind Analytics")).toBe(true);
    expect(companyMatches("northwind-analytics.com", "Northwind Analytics Ltd.")).toBe(true);
    expect(companyMatches("careers-northwind.com", "Northwind")).toBe(true);
    expect(companyMatches("northwindjobs.co.uk", "Northwind")).toBe(true);
    expect(companyMatches("ibm.com", "International Business Machines")).toBe(true);
  });

  it("does not match an agency's or another company's domain", () => {
    expect(companyMatches("talentbridge.io", "Northwind Analytics")).toBe(false);
    expect(companyMatches("hrsolutions.com", "Northwind")).toBe(false);
  });

  it("matches anything when the post names no company, since there is nothing to compare", () => {
    expect(companyMatches("acme.com", "")).toBe(true);
  });
});
