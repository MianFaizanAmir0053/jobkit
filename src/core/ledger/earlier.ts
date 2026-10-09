import type { Clock, Db } from "@/core/ports";

import { companyKey, companyRoleHash } from "./normalise";
import type { Route } from "./statuses";

/**
 * Applications made before jobkit, imported from the owner's list (ledger
 * spec, "Earlier applications"; ADR 0001 entry 17): CSV rows of company,
 * role, applied_on, route and an optional address. Every row is checked and
 * a bad one is reported by its line; rows are keyed on company-role hash
 * and date, so importing a list twice adds nothing.
 */
export interface EarlierRow {
  line: number;
  company: string;
  role: string;
  /** A calendar date, YYYY-MM-DD. */
  appliedOn: string;
  route: Route;
  address: string | null;
}

export interface ImportProblem {
  line: number;
  message: string;
}

const ROUTES: readonly string[] = ["email", "form", "message"];
const HEADER = ["company", "role", "applied_on", "route", "address"];

export function parseEarlierCsv(
  text: string,
  today: Date,
): { rows: EarlierRow[]; errors: ImportProblem[] } {
  const { records, unclosedAt } = readCsv(text.replace(/^﻿/, ""));
  const rows: EarlierRow[] = [];
  const errors: ImportProblem[] = [];
  const first = records[0]?.fields.map((field) => field.trim().toLowerCase());
  const body = first && HEADER.slice(0, first.length).join() === first.join() ? records.slice(1) : records;
  for (const { line, fields } of body) {
    const checked = checkRow(fields, today);
    if (typeof checked === "string") errors.push({ line, message: checked });
    else rows.push({ line, ...checked });
  }
  if (unclosedAt !== null) errors.push({ line: unclosedAt, message: "a quoted field is never closed" });
  return { rows, errors };
}

function checkRow(fields: readonly string[], today: Date): Omit<EarlierRow, "line"> | string {
  if (fields.length !== 4 && fields.length !== 5) {
    return `expected company, role, applied_on, route and an optional address, but found ${fields.length} fields`;
  }
  const [company, role, appliedOn, route, address = ""] = fields.map((field) => field.trim()) as [
    string,
    string,
    string,
    string,
    string?,
  ];
  if (company === "") return "company is empty";
  if (companyKey(company) === null) return "company has no name besides its legal form";
  if (role === "") return "role is empty";
  if (!isCalendarDate(appliedOn)) {
    return `applied_on must be a date such as 2026-05-04, not ${JSON.stringify(appliedOn)}`;
  }
  if (appliedOn > today.toISOString().slice(0, 10)) return "applied_on is after today";
  if (!ROUTES.includes(route)) {
    return `route must be email, form or message, not ${JSON.stringify(route)}`;
  }
  if (address !== "" && !looksLikeAddress(address)) {
    return `address must be an email address or a phone number, not ${JSON.stringify(address)}`;
  }
  return { company, role, appliedOn, route: route as Route, address: address === "" ? null : address };
}

function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  // A date that does not exist, such as 2026-02-30, comes back as another day.
  return new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
}

function looksLikeAddress(text: string): boolean {
  if (text.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  return /^[+\d\s().-]+$/.test(text) && text.replace(/\D/g, "").length >= 7;
}

/**
 * CSV records with the line each starts on. A field may be quoted, with a
 * doubled quote for a quote and commas or line breaks inside; blank lines
 * are skipped.
 */
function readCsv(text: string): {
  records: { line: number; fields: string[] }[];
  unclosedAt: number | null;
} {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0]!.trim() !== "") records.push({ line: start, fields });
    fields = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === "\n") line++;
        field += char;
      }
    } else if (char === '"' && field === "") {
      // Only a quote that opens a field quotes it; one inside a plain field
      // is kept, as spreadsheets write it.
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n") {
      endRecord();
      line++;
      start = line;
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (quoted) return { records, unclosedAt: start };
  endRecord();
  return { records, unclosedAt: null };
}

/** Stores the rows; a row already there, by company-role hash and date, is left alone. */
export async function importEarlier(
  deps: { db: Db; clock: Clock },
  rows: readonly EarlierRow[],
): Promise<{ inserted: number; alreadyThere: number }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    let inserted = 0;
    for (const row of rows) {
      const { rowCount } = await tx.query(
        `insert into {{schema}}.earlier_applications
           (company, role, company_role_hash, applied_on, route, address, imported_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (company_role_hash, applied_on) do nothing`,
        [row.company, row.role, companyRoleHash(row.company, row.role), row.appliedOn, row.route, row.address, now],
      );
      inserted += rowCount;
    }
    return { inserted, alreadyThere: rows.length - inserted };
  });
}
