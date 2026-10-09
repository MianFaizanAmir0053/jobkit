import type { Clock, Db } from "@/core/ports";

import { companyKey, companyRoleHash, roleKey } from "./normalise";
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

/** The furthest any time zone runs ahead of UTC (UTC+14), so a date that is today anywhere is not in the future. */
const AHEAD_OF_UTC_MS = 14 * 60 * 60 * 1000;

/** Applications before this are typing slips, such as 0026 for 2026. */
const EARLIEST_DATE = "2000-01-01";

export function parseEarlierCsv(
  text: string,
  today: Date,
): { rows: EarlierRow[]; errors: ImportProblem[] } {
  const { records, unclosedAt } = readCsv(text.replace(/^﻿/, ""));
  const rows: EarlierRow[] = [];
  const errors: ImportProblem[] = [];
  // One row per company, role and date, the key the import stores rows by.
  const seen = new Map<string, number>();
  const first = records[0]?.fields.map((field) => field.trim().toLowerCase());
  const body =
    first && HEADER.slice(0, first.length).join() === first.join() ? records.slice(1) : records;
  for (const { line, fields } of body) {
    const checked = checkRow(fields, today);
    if (typeof checked === "string") {
      errors.push({ line, message: checked });
      continue;
    }
    const key = `${companyRoleHash(checked.company, checked.role)}|${checked.appliedOn}`;
    const earlierLine = seen.get(key);
    if (earlierLine !== undefined) {
      errors.push({ line, message: `the same company, role and date as line ${earlierLine}` });
      continue;
    }
    seen.set(key, line);
    rows.push({ line, ...checked });
  }
  if (unclosedAt !== null)
    errors.push({ line: unclosedAt, message: "a quoted field is never closed" });
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
  if (roleKey(role) === "") return "role has no title besides a place or a work mode";
  if (!isCalendarDate(appliedOn)) {
    return `applied_on must be a date such as 2026-05-04, not ${JSON.stringify(appliedOn)}`;
  }
  if (appliedOn < EARLIEST_DATE) return "applied_on is before 2000";
  const latestToday = new Date(today.getTime() + AHEAD_OF_UTC_MS).toISOString().slice(0, 10);
  if (appliedOn > latestToday) return "applied_on is after today";
  if (!ROUTES.includes(route)) {
    return `route must be email, form or message, not ${JSON.stringify(route)}`;
  }
  if (address !== "" && !looksLikeAddress(address)) {
    return `address must be an email address or a phone number, not ${JSON.stringify(address)}`;
  }
  return {
    company,
    role,
    appliedOn,
    route: route as Route,
    address: address === "" ? null : address,
  };
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

/**
 * Stores the rows, keyed on company-role hash and date. A row already there
 * is left alone, or corrected when the list now spells its company or role
 * differently or gives another route or address; a corrected row counts as
 * imported now, so the duplicate check treats what changed as new.
 */
export async function importEarlier(
  deps: { db: Db; clock: Clock },
  rows: readonly EarlierRow[],
): Promise<{ inserted: number; updated: number; alreadyThere: number }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      // xmax is 0 on a row this statement inserted, and set on one it updated.
      const { rows: written } = await tx.query<{ inserted: boolean }>(
        `insert into {{schema}}.earlier_applications as earlier
           (company, role, company_role_hash, applied_on, route, address, imported_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (company_role_hash, applied_on) do update
           set company = excluded.company, role = excluded.role, route = excluded.route,
               address = excluded.address, imported_at = excluded.imported_at
           where (earlier.company, earlier.role, earlier.route, earlier.address)
                 is distinct from (excluded.company, excluded.role, excluded.route, excluded.address)
         returning (xmax = 0) as inserted`,
        [
          row.company,
          row.role,
          companyRoleHash(row.company, row.role),
          row.appliedOn,
          row.route,
          row.address,
          now,
        ],
      );
      if (written[0]?.inserted === true) inserted++;
      else if (written[0]) updated++;
    }
    return { inserted, updated, alreadyThere: rows.length - inserted - updated };
  });
}
