import { describe, expect, it } from "vitest";

import { parseEarlierCsv } from "./earlier";

const TODAY = new Date("2026-10-15T12:00:00Z");

describe("parseEarlierCsv", () => {
  it("reads rows with or without a header, with the address optional", () => {
    const text = [
      "company,role,applied_on,route,address",
      "Acme Ltd,Frontend Developer,2026-05-04,email,jobs@acme.example",
      "Globex,Designer,2026-06-01,form",
      "Initech,Backend Engineer,2026-06-02,message,+92 300 1234567",
    ].join("\n");

    expect(parseEarlierCsv(text, TODAY)).toEqual({
      rows: [
        { line: 2, company: "Acme Ltd", role: "Frontend Developer", appliedOn: "2026-05-04", route: "email", address: "jobs@acme.example" },
        { line: 3, company: "Globex", role: "Designer", appliedOn: "2026-06-01", route: "form", address: null },
        { line: 4, company: "Initech", role: "Backend Engineer", appliedOn: "2026-06-02", route: "message", address: "+92 300 1234567" },
      ],
      errors: [],
    });
    expect(parseEarlierCsv("Globex,Designer,2026-06-01,form", TODAY).rows).toHaveLength(1);
  });

  it("reads quoted fields with commas and quotes, Windows line ends, blank lines and a byte-order mark", () => {
    const text = '﻿"Acme, Inc.",Senior "Platform" Engineer,2026-05-04,email,\r\n\r\n"Say ""hi"" Ltd",Dev,2026-05-05,form\r\n';

    expect(parseEarlierCsv(text, TODAY)).toEqual({
      rows: [
        { line: 1, company: "Acme, Inc.", role: 'Senior "Platform" Engineer', appliedOn: "2026-05-04", route: "email", address: null },
        { line: 3, company: 'Say "hi" Ltd', role: "Dev", appliedOn: "2026-05-05", route: "form", address: null },
      ],
      errors: [],
    });
  });

  it("reports every bad row by its line, and keeps the good ones", () => {
    const text = [
      "Acme,Developer,2026-05-04,email",
      "Acme,Developer,2026-05-04",
      ",Developer,2026-05-04,email",
      "Pvt Ltd,Developer,2026-05-04,email",
      "Acme,,2026-05-04,email",
      "Acme,Developer,2026-02-30,email",
      "Acme,Developer,May 4,email",
      "Acme,Developer,2026-10-16,email",
      "Acme,Developer,2026-05-04,linkedin",
      "Acme,Developer,2026-05-04,email,not an address",
    ].join("\n");

    const parsed = parseEarlierCsv(text, TODAY);

    expect(parsed.rows.map((row) => row.line)).toEqual([1]);
    expect(parsed.errors).toEqual([
      { line: 2, message: "expected company, role, applied_on, route and an optional address, but found 3 fields" },
      { line: 3, message: "company is empty" },
      { line: 4, message: "company has no name besides its legal form" },
      { line: 5, message: "role is empty" },
      { line: 6, message: 'applied_on must be a date such as 2026-05-04, not "2026-02-30"' },
      { line: 7, message: 'applied_on must be a date such as 2026-05-04, not "May 4"' },
      { line: 8, message: "applied_on is after today" },
      { line: 9, message: 'route must be email, form or message, not "linkedin"' },
      { line: 10, message: 'address must be an email address or a phone number, not "not an address"' },
    ]);
  });

  it("counts the lines a quoted field spans, so later rows keep their own line numbers", () => {
    const text = '"Acme\nLabs",Dev,2026-05-04,email\nGlobex,Designer,2026-06-01,linkedin';

    expect(parseEarlierCsv(text, TODAY)).toEqual({
      rows: [expect.objectContaining({ line: 1, company: "Acme\nLabs" })],
      errors: [{ line: 3, message: 'route must be email, form or message, not "linkedin"' }],
    });
  });

  it("reports a quote that is never closed", () => {
    expect(parseEarlierCsv('Acme,Developer,2026-05-04,email\n"Globex,Designer,2026-06-01,form', TODAY).errors).toEqual([
      { line: 2, message: "a quoted field is never closed" },
    ]);
  });
});
