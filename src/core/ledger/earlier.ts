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

/** A stored row's key: its company-role hash by today's rules, and its date. */
function keyOf(row: { company: string; role: string; appliedOn: string }): string {
  return `${companyRoleHash(row.company, row.role)}|${row.appliedOn}`;
}

/**
 * Re-keys the rows stored under older normalisation rules, so a row the
 * list names again is found again rather than stored twice. Of two rows
 * that now share a key, the newer goes.
 */
async function rekey(db: Db): Promise<void> {
  const { rows } = await db.query<{
    id: string;
    company: string;
    role: string;
    company_role_hash: string;
    applied_on: string;
  }>(
    `select id, company, role, company_role_hash, applied_on::text as applied_on
       from {{schema}}.earlier_applications order by imported_at, id`,
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const hash = companyRoleHash(row.company, row.role)!;
    const key = `${hash}|${row.applied_on}`;
    if (seen.has(key)) {
      await db.query("delete from {{schema}}.earlier_applications where id = $1", [row.id]);
      continue;
    }
    seen.add(key);
    if (hash !== row.company_role_hash) {
      await db.query(
        "update {{schema}}.earlier_applications set company_role_hash = $2 where id = $1",
        [row.id, hash],
      );
    }
  }
}

/**
 * Stores the rows, keyed on company-role hash and date. A row already there
 * is left alone, or corrected in place when the list now spells its company
 * or role differently or gives another route or address. A corrected row
 * keeps its ID, so the duplicate matches the owner has already seen stay
 * covered; a new address is a new match.
 */
export async function importEarlier(
  deps: { db: Db; clock: Clock },
  rows: readonly EarlierRow[],
): Promise<{ inserted: number; updated: number; alreadyThere: number }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    await rekey(tx);
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

/**
 * Makes the stored list the file's (npm run ledger:import -- <file>
 * --replace): removes the rows the file no longer has, such as one whose
 * company or role was misspelt, and imports the rest as importEarlier does,
 * so the rows that stay keep their IDs. An empty list is refused: it would
 * remove every earlier application.
 */
export async function replaceEarlier(
  deps: { db: Db; clock: Clock },
  rows: readonly EarlierRow[],
): Promise<{ removed: number; inserted: number; updated: number; alreadyThere: number }> {
  if (rows.length === 0)
    throw new Error("The list is empty, so --replace would remove every earlier application.");
  const kept = new Set(rows.map(keyOf));
  return deps.db.tx(async (tx) => {
    await rekey(tx);
    const { rows: stored } = await tx.query<{
      id: string;
      company: string;
      role: string;
      applied_on: string;
    }>(
      `select id, company, role, applied_on::text as applied_on from {{schema}}.earlier_applications`,
    );
    const gone = stored
      .filter((row) => !kept.has(keyOf({ ...row, appliedOn: row.applied_on })))
      .map((row) => row.id);
    if (gone.length > 0) {
      await tx.query("delete from {{schema}}.earlier_applications where id = any($1::uuid[])", [
        gone,
      ]);
    }
    return { removed: gone.length, ...(await importEarlier({ db: tx, clock: deps.clock }, rows)) };
  });
}
