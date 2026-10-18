import { describe, expect, it } from "vitest";

import type { DuplicateMatch } from "@/core/ledger/duplicates";

import { duplicateLine, placeOfFlag, withoutContacts } from "./words";

/*
 * Where a flag on what extract read points, what a duplicate match found,
 * in the owner's words, and the post's words with jobkit's reading of a
 * contact set aside while the owner must type it.
 */

describe("placeOfFlag", () => {
  it("names the role, the entry and the contact a path points at", () => {
    expect(placeOfFlag("roles[1].requirements[2].id")).toBe("Role 2, requirement 3");
    expect(placeOfFlag("roles[0].screening_questions[0].id")).toBe("Role 1, question 1");
    expect(placeOfFlag("roles[0].route.address")).toBe("Role 1, contact");
    expect(placeOfFlag("roles[2].id")).toBe("Role 3");
  });

  it("names nothing for a flag on the whole record", () => {
    expect(placeOfFlag("roles")).toBe("");
    expect(placeOfFlag("company.name")).toBe("");
  });
});

describe("duplicateLine", () => {
  const match = (overrides: Partial<DuplicateMatch>): DuplicateMatch => ({
    reason: "company-role",
    source: "application",
    company: "Acme",
    role: "Frontend Developer",
    at: new Date("2026-10-13T21:10:00Z"),
    applied: true,
    bounced: false,
    key: "application:1:company-role",
    ...overrides,
  });

  it("says when an earlier application went out, in the owner's time zone", () => {
    expect(duplicateLine(match({}), "Asia/Karachi")).toEqual({
      what: "The same company and role: Acme, Frontend Developer",
      when: "applied with jobkit, 14 Oct 2026, 02:10",
    });
    expect(duplicateLine(match({ source: "manual-run" }), "Asia/Karachi").when).toBe(
      "a manual run, 14 Oct 2026, 02:10",
    );
  });

  it("says an earlier email that bounced was sent and bounced", () => {
    expect(duplicateLine(match({ bounced: true }), "Asia/Karachi").when).toBe(
      "sent with jobkit and bounced, 14 Oct 2026, 02:10",
    );
  });

  it("says a kit that never went out was drafted, not applied", () => {
    expect(duplicateLine(match({ reason: "address", applied: false }), "Asia/Karachi")).toEqual({
      what: "The same address: Acme, Frontend Developer",
      when: "drafted with jobkit and never sent, 14 Oct 2026, 02:10",
    });
    expect(duplicateLine(match({ reason: "drafted", applied: false }), "Asia/Karachi").what).toBe(
      "A kit already drafted for the same company and role: Acme, Frontend Developer",
    );
  });

  it("names a company or role the earlier post left out as not named, never as nothing", () => {
    expect(duplicateLine(match({ company: "", role: "" }), "Asia/Karachi").what).toBe(
      "The same company and role: a company it did not name, a role it did not name",
    );
  });

  it("gives an imported application's day as the owner's list has it, with no time", () => {
    const imported = match({ source: "earlier", at: new Date("2026-05-04T00:00:00Z") });

    expect(duplicateLine(imported, "America/New_York").when).toBe(
      "an earlier application, 4 May 2026",
    );
  });
});

describe("withoutContacts", () => {
  it("sets aside every address in the post's words while the owner must type one", () => {
    expect(withoutContacts("Send your CV to jobs@acrne.com or <HR@acme.com>.", "email")).toBe(
      "Send your CV to (an address: read it in the post) or <(an address: read it in the post)>.",
    );
    expect(withoutContacts("Apply now: spy%40evil.example.net%2Chr@example.com", "email")).toBe(
      "Apply now: (an address: read it in the post)",
    );
  });

  it("sets aside every number while the owner must type the WhatsApp number", () => {
    expect(withoutContacts("WhatsApp 0300 0000000 or +92 (321) 765-4321 today", "whatsapp")).toBe(
      "WhatsApp (a number: read it in the post) or (a number: read it in the post) today",
    );
    expect(withoutContacts("Salary PKR 150,000; 3+ years", "whatsapp")).toBe(
      "Salary PKR 150,000; 3+ years",
    );
  });

  it("leaves the words alone when the owner need not type the contact", () => {
    expect(withoutContacts("Apply: jobs@acme.com, 0300 0000000", null)).toBe(
      "Apply: jobs@acme.com, 0300 0000000",
    );
  });
});
