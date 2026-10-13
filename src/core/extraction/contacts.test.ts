import { describe, expect, it } from "vitest";

import { NUMBER_FLAG, isStrictAddress, normaliseWhatsAppNumber } from "./contacts";

const EN_DASH = String.fromCharCode(0x2013);
const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);

/*
 * Extraction AC8. A post must not be able to smuggle a recipient or a header
 * into the handoff link, so an address passes only in a narrow form; a
 * number passes only in a form whose country is certain.
 */
describe("isStrictAddress", () => {
  it.each([
    ["a second recipient after a query", "hr@acme.com?bcc=x@evil.com"],
    ["a percent-encoded second recipient", "spy%40evil.com%2Chr@acme.com"],
    ["a fragment mark", "a#b@acme.com"],
    ["a quoted local part", '"hr"@acme.com'],
    ["a doubled dot", "hr..x@acme.com"],
    ["a domain without a public suffix", "hr@acme"],
    ["two at signs", "hr@@acme.com"],
  ])("fails %s", (_case, address) => {
    expect(isStrictAddress(address)).toBe(false);
  });

  it("passes a plus tag and a two-part public suffix", () => {
    expect(isStrictAddress("jobs+dev@acme.co.uk")).toBe(true);
  });

  it.each([
    ["the documentation domains the synthetic posts use", "jobs@example.com"],
    ["underscores, hyphens and dots", "first.last_name-x@mail.example.org"],
    ["capitals, which the review compares without case", "Jobs@Example.COM"],
  ])("passes %s", (_case, address) => {
    expect(isStrictAddress(address)).toBe(true);
  });

  it.each([
    ["an empty value", ""],
    ["no at sign", "jobs.example.com"],
    ["an empty local part", "@example.com"],
    ["a leading dot", ".jobs@example.com"],
    ["a trailing dot", "jobs.@example.com"],
    ["a space", "jobs @example.com"],
    ["surrounding spaces", " jobs@example.com "],
    ["a comma", "jobs,hr@example.com"],
    ["a slash", "jobs/hr@example.com"],
    ["an ampersand", "jobs&hr@example.com"],
    ["an equals sign", "jobs=hr@example.com"],
    ["an apostrophe", "o'brien@example.com"],
    ["a non-ASCII letter", "jöbs@example.com"],
    ["a line break", "jobs@example.com\nbcc:x@example.net"],
    ["a domain that is only a public suffix", "hr@co.uk"],
    ["a domain ending in a dot", "hr@example.com."],
    ["an empty domain label", "hr@example..com"],
    ["a label starting with a hyphen", "hr@-acme.example.com"],
    ["a label ending with a hyphen", "hr@acme-.example.com"],
    ["an IP address", "hr@[192.0.2.1]"],
    ["a reserved name with no public suffix", "hr@localhost"],
    ["a local part over 64 characters", `${"a".repeat(65)}@example.com`],
    ["a domain label over 63 characters", `hr@${"a".repeat(64)}.example.com`],
    [
      "an address over RFC 5321's 254 characters",
      `${"a".repeat(60)}@${Array.from({ length: 4 }, () => "b".repeat(60)).join(".")}.com`,
    ],
  ])("fails %s", (_case, address) => {
    expect(isStrictAddress(address)).toBe(false);
  });
});

describe("normaliseWhatsAppNumber", () => {
  it.each([
    ["a Pakistani mobile without its country code", "0300 1234567", "923001234567"],
    ["a trunk 0 written as (0) after the country code", "+92 (0)300 1234567", "923001234567"],
    ["a UAE number", "+971 50 123 4567", "971501234567"],
    ["92 and ten digits", "92 300 1234567", "923001234567"],
    ["00 before the country code, with dashes", "0092-300-1234567", "923001234567"],
    ["dots as separators", "+92.300.123.4567", "923001234567"],
    ["a UK number with its trunk 0 in brackets", "+44 (0)20 7946 0958", "442079460958"],
    ["a Saudi number", "+966 50 123 4567", "966501234567"],
    ["a North American number with an area code in brackets", "+1 (555) 010-0123", "15550100123"],
    ["a country code the table does not list", "+49 30 1234567", "49301234567"],
    ["the all-zero number the synthetic posts use", "0300 0000000", "923000000000"],
    ["a space after the plus, before (0)", "+ 92 (0)300 1234567", "923001234567"],
    ["00 and a space before (0)", "00 92 (0)300 1234567", "923001234567"],
    ["an en dash", `0300${EN_DASH}1234567`, "923001234567"],
    ["a non-breaking hyphen", `0300${NON_BREAKING_HYPHEN}1234567`, "923001234567"],
    ["square brackets", "+92 [300] 1234567", "923001234567"],
  ])("accepts %s", (_case, text, number) => {
    expect(normaliseWhatsAppNumber(text)).toEqual({ ok: true, number });
  });

  it.each([
    ["ten digits with no country code", "202 555 0143"],
    ["a Pakistani number without its trunk 0", "300-1234567"],
    ["a Pakistani number two digits short", "+92 300 12345"],
    ["a trunk 0 repeated without brackets", "+92 0300 1234567"],
    ["a UK number one digit short", "+44 20 7946 095"],
    ["a North American number too short", "+1 555 0100"],
    ["a country code starting with 0", "+0300 1234567"],
    ["a Pakistani mobile one digit short", "0300 123456"],
    ["a letter", "+92 300 123456a"],
    ["an empty value", ""],
    ["digits of another script", "۰۳۰۰ ۱۲۳۴۵۶۷"],
    ["a label", "WhatsApp: 0300 1234567"],
    ["a wa.me link", "wa.me/923001234567"],
    ["more than 15 digits", "+49 1234 5678 9012 3456"],
    ["fewer than 8 digits", "+49 1234"],
    ["a 0 straight after Pakistan's code", "+92 0300 123456"],
    ["92 and a 0 with no plus", "92 0300 123456"],
    ["a 0 straight after the UK's code", "+44 0207 946 095"],
    ["a 0 straight after North America's code", "+1 055 501 0012"],
    ["(0) after digits that are no listed country code", "+923 (0)00 1234567"],
  ])("flags %s", (_case, text) => {
    expect(normaliseWhatsAppNumber(text)).toEqual({ ok: false, reason: NUMBER_FLAG });
  });

  it("asks the owner to check the country code, and never guesses one", () => {
    expect(NUMBER_FLAG).toBe("Check this number's country code");
  });
});
