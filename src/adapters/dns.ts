import dns, { Resolver } from "node:dns/promises";

import type { Dns, DnsAnswer } from "@/core/ports";

/**
 * The Dns port on Node's resolver (review spec, "Stage address_checks"):
 * one try per name server, each waiting at most three seconds, so a check
 * gives up rather than holding the drafting group. A name with no records
 * of the type asked, or no such name, has none; a timeout is a timeout;
 * anything else failed.
 *
 * Source: https://nodejs.org/api/dns.html (Resolver options; "On error,
 * the Promise is rejected with an Error object, where err.code is one of
 * the DNS error codes", which dnsPromises exports).
 */

const TIMEOUT_MS = 3_000;

const NONE: ReadonlySet<string> = new Set([dns.NODATA, dns.NOTFOUND]);

/**
 * The test server's DNS: every domain has a mail host, so end-to-end tests
 * run offline and the same every time.
 */
export function offlineDns(): Dns {
  return {
    async lookup(name, type) {
      return type === "MX" ? { kind: "records", values: [`mx.${name}`] } : { kind: "none" };
    },
  };
}

export function createDns(opts: { timeoutMs?: number } = {}): Dns {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? TIMEOUT_MS, tries: 1 });
  return {
    async lookup(name, type): Promise<DnsAnswer> {
      try {
        const values =
          type === "MX"
            ? (await resolver.resolveMx(name)).map((record) => record.exchange)
            : type === "A"
              ? await resolver.resolve4(name)
              : await resolver.resolve6(name);
        return values.length > 0 ? { kind: "records", values } : { kind: "none" };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && NONE.has(code)) return { kind: "none" };
        if (code === dns.TIMEOUT) return { kind: "timeout" };
        return { kind: "failed" };
      }
    },
  };
}
