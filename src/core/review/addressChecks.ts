import { parse } from "tldts";

import { isStrictAddress } from "@/core/extraction/contacts";
import type { Dns } from "@/core/ports";

/**
 * The address checks (review spec, "Stage address_checks"): the strict
 * check, a mail host for the domain, free mail, and the domain against the
 * company's name. Only a failed strict check and a domain that takes no
 * mail block; the rest warn, since agencies and parent companies mail from
 * names unlike the company's. There is no domain-age check (amendment A5).
 */

/**
 * Raise it when these checks, or isStrictAddress in contacts.ts, change what
 * they find, so a kept result is not reused.
 */
export const ADDRESS_CHECKS_VERSION = 2;

export type MailHost = "mx" | "implicit_mx" | "null_mx" | "none" | "unchecked";

export interface AddressCheck {
  /** "not_checked": the address as it stands has no checks, which the job view says. */
  kind: "syntax" | "mail_host" | "free_mail" | "company" | "not_checked";
  /** A blocking check stops every handoff until the address is fixed; a warning only shows. */
  blocking: boolean;
  message: string;
}

export const ADDRESS_CHECK_MESSAGES = {
  syntax: "This address did not pass the strict check. Type it yourself from the post.",
  null_mx: "This address's domain says it takes no email. Check the address in the post.",
  none: "This address's domain has no mail server. Check the address in the post.",
  unchecked: "Couldn't check the mail server.",
  free_mail: "A personal address, not a company one.",
  company:
    "The address's domain is unlike the company's name. Agencies and parent companies often differ; check it.",
} as const;

/**
 * Where mail for a domain goes: its MX records; with none, an address
 * record as the implicit host (RFC 5321); a single MX for the root takes no
 * mail (null MX, RFC 7505). A timeout or a DNS failure leaves it unchecked.
 */
export async function mailHostOf(dns: Dns, domain: string): Promise<MailHost> {
  const mx = await dns.lookup(domain, "MX");
  if (mx.kind === "records") {
    const isNull = mx.values.length === 1 && (mx.values[0] === "" || mx.values[0] === ".");
    return isNull ? "null_mx" : "mx";
  }
  if (mx.kind !== "none") return "unchecked";
  const [a, aaaa] = await Promise.all([dns.lookup(domain, "A"), dns.lookup(domain, "AAAA")]);
  if (a.kind === "records" || aaaa.kind === "records") return "implicit_mx";
  return a.kind === "none" && aaaa.kind === "none" ? "none" : "unchecked";
}

/** Free-mail providers: these domains, and any domain of these names under any suffix ("yahoo.co.uk"). */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "mail.com",
  "rediffmail.com",
]);
const FREE_MAIL_NAMES: ReadonlySet<string> = new Set(["yahoo", "hotmail", "gmx", "yandex"]);

export function isFreeMail(domain: string): boolean {
  const parsed = parse(domain);
  return (
    (parsed.domain !== null && FREE_MAIL_DOMAINS.has(parsed.domain)) ||
    (parsed.domainWithoutSuffix !== null && FREE_MAIL_NAMES.has(parsed.domainWithoutSuffix))
  );
}

/** Words a careers address puts around a company's name: "careers-acme", "acmejobs". */
const RECRUITING_WORDS = [
  "careers",
  "career",
  "jobs",
  "job",
  "hr",
  "recruitment",
  "recruiting",
  "hiring",
  "talent",
] as const;

/** Words a company's name carries that its domain usually drops. */
const NAME_FILLER: ReadonlySet<string> = new Set([
  "ltd",
  "limited",
  "inc",
  "llc",
  "plc",
  "pvt",
  "private",
  "co",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "group",
  "the",
  "and",
  "of",
]);

/** The domain's registrable name, without hyphens or the recruiting words around the company's name. */
function labelOf(domain: string): string {
  const name = (parse(domain).domainWithoutSuffix ?? "").toLowerCase();
  let label = name
    .split("-")
    .filter((part) => !(RECRUITING_WORDS as readonly string[]).includes(part))
    .join("");
  for (const word of RECRUITING_WORDS) {
    if (label.startsWith(word) && label.length - word.length >= 3) label = label.slice(word.length);
    if (label.endsWith(word) && label.length - word.length >= 3)
      label = label.slice(0, -word.length);
  }
  return label;
}

/** A name's words, lower case and without accents. */
function wordsOf(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/**
 * Whether a domain's name overlaps the company's: one holds a word of the
 * other's three letters or more, they are the same once joined, or the
 * domain is the name's initials ("ibm.com"). A post that names no company
 * leaves nothing to compare, so it matches; a domain made only of
 * recruiting words ("careers-hiring.com") names none, so it does not.
 */
export function companyMatches(domain: string, company: string): boolean {
  const words = wordsOf(company).filter((word) => !NAME_FILLER.has(word));
  const label = labelOf(domain);
  if (words.length === 0) return true;
  if (label === "") return false;
  const joined = words.join("");
  const initials = words.map((word) => word[0]).join("");
  return (
    label === joined ||
    words.some((word) => word.length >= 3 && label.includes(word)) ||
    (label.length >= 3 && joined.includes(label)) ||
    (initials.length >= 2 && label === initials)
  );
}

/** Every check on an address, in the order the page lists them. */
export async function checkAddress(
  dns: Dns,
  address: string,
  company: string,
): Promise<AddressCheck[]> {
  if (!isStrictAddress(address)) {
    return [{ kind: "syntax", blocking: true, message: ADDRESS_CHECK_MESSAGES.syntax }];
  }
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const checks: AddressCheck[] = [];
  const host = await mailHostOf(dns, domain);
  if (host === "null_mx" || host === "none") {
    checks.push({ kind: "mail_host", blocking: true, message: ADDRESS_CHECK_MESSAGES[host] });
  } else if (host === "unchecked") {
    checks.push({ kind: "mail_host", blocking: false, message: ADDRESS_CHECK_MESSAGES.unchecked });
  }
  if (isFreeMail(domain)) {
    checks.push({ kind: "free_mail", blocking: false, message: ADDRESS_CHECK_MESSAGES.free_mail });
  } else if (!companyMatches(domain, company)) {
    checks.push({ kind: "company", blocking: false, message: ADDRESS_CHECK_MESSAGES.company });
  }
  return checks;
}
