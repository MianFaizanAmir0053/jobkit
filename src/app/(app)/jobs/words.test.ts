import { describe, expect, it } from "vitest";

import type { DuplicateMatch } from "@/core/ledger/duplicates";

import { duplicateLine, placeOfFlag } from "./words";

/* Where a flag on what extract read points, and what a duplicate match found, in the owner's words. */

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
